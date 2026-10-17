// OpenClaw ring-zero tool tests: approval gating, action mapping, verification.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { hashSystemAgentOperation } from "../../system-agent/operator-approval.js";
import {
  createSystemAgentTool,
  resolveSystemAgentDirectiveTransition,
  resolveSystemAgentProposalTransition,
  type SystemAgentToolDirective,
  type SystemAgentToolOptions,
} from "./system-agent-tool.js";

const mocks = vi.hoisted(() => ({
  preparePluginArtifact: vi.fn(),
  executeSystemAgentOperation: vi.fn(
    async (_op: unknown, runtime: { log: (m: string) => void }) => {
      runtime.log("op-output");
      return { applied: false };
    },
  ),
}));

vi.mock("../../system-agent/plugin-artifact.js", () => ({
  prepareSystemAgentPluginArtifact: mocks.preparePluginArtifact,
}));

vi.mock("../../system-agent/operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../system-agent/operations.js")>()),
  executeSystemAgentOperation: mocks.executeSystemAgentOperation,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function makeTool(options: Partial<SystemAgentToolOptions> = {}) {
  return createSystemAgentTool({ surface: "gateway", ...options });
}

function gatewayFixture() {
  const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
  return { proposalRef, tool: makeTool({ proposalRef }) };
}

describe("openclaw tool", () => {
  it("stays directly callable instead of entering tool catalogs", () => {
    const tool = createSystemAgentTool({ surface: "cli" });
    expect(tool.catalogMode).toBe("direct-only");
    expect(tool.description).toContain("Direct chat: exact user approval, then approved=true.");
    expect(tool.description).toContain("host applies session permission policy");
  });

  it("runs read actions immediately", async () => {
    const tool = createSystemAgentTool({ surface: "cli" });
    const result = await tool.execute("t1", { action: "status" });
    expect(toolText(result)).toContain("op-output");
    expect(mocks.executeSystemAgentOperation).toHaveBeenCalledWith(
      { kind: "status" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );

    await tool.execute("t1b", { action: "channel_info", channel: "Slack" });
    expect(mocks.executeSystemAgentOperation).toHaveBeenCalledWith(
      { kind: "channel-info", channel: "slack" },
      expect.anything(),
      expect.objectContaining({ approved: false }),
    );
  });

  it("preserves an allowed gateway credential reference as an exact proposal", async () => {
    const { proposalRef, tool } = gatewayFixture();
    const result = await tool.execute("gateway-reference", {
      action: "config_set_ref",
      path: "gateway.auth.token",
      envVar: "GATEWAY_TOKEN",
    });
    expect(toolText(result)).toContain("needs-approval");
    expect(proposalRef.operation).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source: "env",
      id: "GATEWAY_TOKEN",
    });
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("proposes storing a key the user gave in chat without repeating it", async () => {
    const { proposalRef, tool } = gatewayFixture();
    const secret = " sk-owner-pasted-9d2e4b7c\n";
    const result = await tool.execute("owner-key", {
      action: "config_set_ref",
      path: "models.providers.openai.apiKey",
      secret,
    });
    expect(toolText(result)).toContain("needs-approval");
    expect(toolText(result)).not.toContain(secret);
    expect(proposalRef.operation).toEqual({
      kind: "config-set-ref",
      path: "models.providers.openai.apiKey",
      source: "store",
      id: "MODELS_PROVIDERS_OPENAI_API_KEY",
      secret,
    });
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("rejects mixed credential sources before staging", async () => {
    const { proposalRef, tool } = gatewayFixture();
    await expect(
      tool.execute("mixed-source", {
        action: "config_set_ref",
        path: "models.providers.openai.apiKey",
        secret: "fixture-mixed-source-secret",
        envVar: "EXISTING_API_KEY",
        approved: true,
      }),
    ).rejects.toThrow("either secret or envVar, not both");
    expect(proposalRef).toEqual({});
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("createSystemAgentTool.execute does not stage a config proposal when cancelled", async () => {
    const { proposalRef, tool } = gatewayFixture();
    const controller = new AbortController();
    controller.abort(new Error("Setup cancelled"));
    const pending = tool.execute(
      "cancelled-proposal",
      { action: "config_set", path: "gateway.port", value: "19001" },
      controller.signal,
    );
    await expect(pending).rejects.toThrow("Setup cancelled");
    expect(proposalRef).toEqual({});
  });

  it("rejects arbitrary plugin installs before creating an approval proposal", async () => {
    const proposalRef: { current?: string } = {};
    const tool = createSystemAgentTool({ surface: "cli", proposalRef });

    await expect(
      tool.execute("plugin-install", {
        action: "plugin_install",
        spec: "npm:@example/plugin",
        approved: true,
      }),
    ).rejects.toThrow(/trusted shell/);
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("finishes the exact artifact review before proposing and hands approved bytes to the host", async () => {
    const args = {
      action: "plugin_activate_artifact",
      path: "/tmp/authored-plugin.tgz",
      sha256: "a".repeat(64),
    };
    const operation = {
      kind: "plugin-activate-artifact" as const,
      path: args.path,
      sha256: args.sha256,
    };
    const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
    const started = createDeferred();
    const review = createDeferred<unknown>();
    mocks.preparePluginArtifact.mockImplementationOnce(async () => {
      started.resolve();
      return await review.promise;
    });
    const pending = createSystemAgentTool({
      surface: "gateway",
      operatorApprovalOnly: true,
      proposalRef,
    }).execute("artifact", args);
    await started.promise;
    expect(proposalRef.current).toBeUndefined();
    review.resolve({ pluginId: "authored-plugin", nativeControlUi: true, sha256: args.sha256 });
    const result = await pending;
    expect(toolText(result)).toContain("Reviewed plugin artifact");
    expect(toolText(result)).toContain("requesting session's permission policy");
    expect(resolveSystemAgentProposalTransition({ args, resultText: toolText(result) })).toEqual({
      proposal: hashSystemAgentOperation(operation),
      operation,
    });
    const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
    await createSystemAgentTool({
      surface: "gateway",
      approvalArmed: true,
      proposalRef,
      directiveRef,
    }).execute("approved-artifact", { ...args, approved: true });
    expect(directiveRef.current).toEqual({ kind: "approved-operation", operation });
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.preparePluginArtifact).toHaveBeenCalledOnce();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("does not propose a failed artifact review or overwrite another proposal after review", async () => {
    const args = {
      action: "plugin_activate_artifact",
      path: "/tmp/authored-plugin.tgz",
      sha256: "b".repeat(64),
    };
    const { proposalRef, tool } = gatewayFixture();
    mocks.preparePluginArtifact.mockRejectedValueOnce(new Error("SHA256 does not match"));
    await expect(tool.execute("invalid-artifact", args)).rejects.toThrow("SHA256 does not match");
    expect(proposalRef.current).toBeUndefined();
    const prior = hashSystemAgentOperation({ kind: "gateway-restart" });
    mocks.preparePluginArtifact.mockImplementationOnce(async () => {
      proposalRef.current = prior;
      proposalRef.operation = { kind: "gateway-restart" };
      return { pluginId: "authored-plugin" };
    });
    expect(toolText(await tool.execute("racing-artifact", args))).toContain(
      `proposal-conflict:${prior}`,
    );
    expect(proposalRef.operation).toEqual({ kind: "gateway-restart" });
  });

  it("defers an approved mutation to the host after the full proposal handshake", async () => {
    const { proposalRef, tool: proposingTool } = gatewayFixture();
    const args = { action: "set_default_model", model: "openai/gpt-5.5", approved: true };
    const expected: SystemAgentToolDirective = {
      kind: "approved-operation",
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    };
    const denied = await proposingTool.execute("t3a", args);
    expect(toolText(denied)).toContain("needs-approval");
    expect(proposalRef.current).toBeDefined();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();

    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const armedTool = makeTool({ approvalArmed: true, proposalRef, directiveRef });
    const result = await armedTool.execute("t3b", args);
    expect(toolText(result)).toContain("directive:approved-operation:");
    expect(directiveRef.current).toEqual(expected);
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
    await armedTool.execute("t3c", { action: "connect_channel", channel: "telegram" });
    expect(directiveRef.current).toEqual(expected);
    // One approval, one mutation.
    expect(proposalRef.current).toBeUndefined();
  });

  it("keeps the first staged config_set proposal instead of overwriting it with a second", async () => {
    const { proposalRef, tool } = gatewayFixture();

    const first = await tool.execute("multi-a", {
      action: "config_set",
      path: "tts.providers.fish-audio.model",
      value: "s2.1-pro",
    });
    expect(toolText(first)).toContain("needs-approval");
    const firstHash = proposalRef.current;
    expect(firstHash).toBeDefined();

    const second = await tool.execute("multi-b", {
      action: "config_set",
      path: "talk.providers.fish-audio.model",
      value: "s2.1-pro",
    });

    // The second, different path must not silently replace the first staged
    // operation: only one operation can ever be approved and applied.
    expect(toolText(second)).toContain("proposal-conflict");
    expect(proposalRef.current).toBe(firstHash);
    expect(proposalRef.operation).toEqual({
      kind: "config-set",
      path: "tts.providers.fish-audio.model",
      value: "s2.1-pro",
    });
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("binds setup approval to the exact verified model and workspace", async () => {
    const { proposalRef, tool } = gatewayFixture();
    const args = { action: "setup", workspace: "/tmp/work", model: "openai/gpt-5.5" };
    const operation = { kind: "setup", workspace: "/tmp/work", model: "openai/gpt-5.5" } as const;
    const result = await tool.execute("setup-proposal", args);
    expect(toolText(result)).toContain("needs-approval");
    expect(proposalRef.current).toBe(hashSystemAgentOperation(operation));
    expect(resolveSystemAgentProposalTransition({ args, resultText: toolText(result) })).toEqual({
      proposal: proposalRef.current,
      operation,
    });
  });

  it.each([
    {
      proposed: { action: "create_agent", agentId: "qa-writer", name: "QA Writer" },
      changed: { action: "create_agent", agentId: "qa-writer", name: "Other Writer" },
    },
  ])(
    "refuses an armed call that differs from the proposed operation: $proposed",
    async ({ proposed, changed }) => {
      const proposalRef: { current?: string } = {};
      const proposingTool = createSystemAgentTool({ surface: "cli", proposalRef });
      await proposingTool.execute("t3c", { ...proposed, approved: true });
      const armedTool = createSystemAgentTool({ surface: "cli", approvalArmed: true, proposalRef });
      const result = await armedTool.execute("t3d", { ...changed, approved: true });
      // A different operation than the approved one voids the approval entirely;
      // even an identical retry in the same armed turn stays locked.
      expect(toolText(result)).toContain("approval-mismatch");
      expect(proposalRef.current).toBeUndefined();
      const retry = await armedTool.execute("t3e", { ...changed, approved: true });
      expect(toolText(retry)).toContain("approval-mismatch");
      expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      args: { action: "create_agent", agentId: "editor", role: "writer" },
      operation: { kind: "create-agent", agentId: "editor", role: "writer" },
    },
    { args: { action: "create_team" }, operation: { kind: "create-team" } },
  ])("stages and hands off the exact creation proposal: $args", async ({ args, operation }) => {
    const proposalRef: { current?: string } = {};
    await createSystemAgentTool({ surface: "cli", proposalRef }).execute("t6a", {
      ...args,
      approved: true,
    });
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const tool = createSystemAgentTool({
      surface: "cli",
      approvalArmed: true,
      proposalRef,
      directiveRef,
    });
    await tool.execute("t6", { ...args, approved: true });
    expect(directiveRef.current).toEqual({ kind: "approved-operation", operation });
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("rejects unknown or underspecified actions as input errors", async () => {
    const tool = createSystemAgentTool({ surface: "cli" });
    await expect(tool.execute("t5", { action: "config_get" })).rejects.toThrow(/path/);
    await expect(
      tool.execute("bad-role", { action: "create_agent", agentId: "work", role: "unknown" }),
    ).rejects.toThrow(/unknown role/);
  });

  it("records interactive directives for the host without executing operations", async () => {
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const tool = createSystemAgentTool({ surface: "cli", directiveRef });

    const connect = await tool.execute("t5", { action: "connect_channel", channel: "Telegram" });
    expect(toolText(connect)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "channel-setup", channel: "telegram" });

    const skills = await tool.execute("t5-skills", { action: "configure_skills" });
    expect(toolText(skills)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "skills-setup" });

    const search = await tool.execute("t5-search", { action: "configure_search" });
    expect(toolText(search)).toContain("directive:");
    expect(toolText(search)).toContain("never ask for or repeat a credential");
    expect(directiveRef.current).toEqual({ kind: "search-setup" });

    const gateway = await tool.execute("t5-gateway", { action: "configure_gateway" });
    expect(toolText(gateway)).toContain("directive:");
    expect(toolText(gateway)).toContain("local Gateway configuration");
    expect(toolText(gateway)).toContain("never ask for or repeat a credential");
    expect(directiveRef.current).toEqual({ kind: "gateway-config-setup" });

    const memory = await tool.execute("t5-memory", { action: "import_memory" });
    expect(toolText(memory)).toContain("directive:");
    expect(toolText(memory)).toContain("copy-only memory import");
    expect(directiveRef.current).toEqual({ kind: "memory-import" });

    const accounts = await tool.execute("t5-accounts", { action: "manage_model_accounts" });
    expect(toolText(accounts)).toContain("Nothing has changed yet");
    expect(directiveRef.current).toEqual({ kind: "model-accounts" });
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "manage_model_accounts" },
        resultText: toolText(accounts),
      }),
    ).toEqual({ kind: "model-accounts" });

    const configureModel = await tool.execute("t6", {
      action: "configure_model_provider",
      workspace: "/tmp/work",
    });
    expect(toolText(configureModel)).toContain("directive:");
    expect(toolText(configureModel)).toContain("protected Models sign-in guidance");
    expect(toolText(configureModel)).toContain("Nothing has changed");
    expect(directiveRef.current).toEqual({ kind: "model-setup", workspace: "/tmp/work" });

    const open = await tool.execute("t7", { action: "open_agent", agentId: "work" });
    expect(toolText(open)).toContain("directive:");
    expect(directiveRef.current).toEqual({ kind: "open-tui", agentId: "work" });

    const setup = await tool.execute("t7", {
      action: "open_setup",
      target: "channels",
      channel: "Slack",
    });
    expect(toolText(setup)).toContain("directive:");
    expect(directiveRef.current).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });

    const guidedSetup = await tool.execute("t8", {
      action: "open_setup",
      target: "guided",
    });
    expect(toolText(guidedSetup)).toContain("cannot run inside OpenClaw");
    expect(toolText(guidedSetup)).toContain("openclaw onboard");
    expect(directiveRef.current).toEqual({ kind: "open-setup", target: "guided" });

    const gatewaySetup = await tool.execute("t9", {
      action: "open_setup",
      target: "gateway",
    });
    expect(toolText(gatewaySetup)).toContain("masked terminal Gateway setup");
    expect(directiveRef.current).toEqual({ kind: "open-setup", target: "gateway" });

    // Directives are host handoffs, never operation executions.
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("does not promise a delegated setup handoff", async () => {
    const args = { action: "open_setup", target: "channels" };
    const directiveRef: { current?: SystemAgentToolDirective } = {};
    const tool = createSystemAgentTool({
      surface: "gateway",
      operatorApprovalOnly: true,
      directiveRef,
    });

    const text = toolText(await tool.execute("delegated-navigation", args));

    expect(text).toContain("cannot run from a delegated agent request");
    expect(directiveRef.current).toBeUndefined();
    expect(resolveSystemAgentDirectiveTransition({ args, resultText: text })).toBeNull();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("mirrors directive transitions for out-of-process (CLI MCP) hosts", () => {
    const check = (
      args: Record<string, unknown>,
      expected: SystemAgentToolDirective,
      resultText = "directive: host handoff",
    ) => expect(resolveSystemAgentDirectiveTransition({ args, resultText })).toEqual(expected);
    check(
      { action: "config_set", path: "gateway.port", value: "19001", approved: true },
      {
        kind: "approved-operation",
        operation: { kind: "config-set", path: "gateway.port", value: "19001" },
      },
      "directive:approved-operation: the host will apply this action.",
    );
    check(
      { action: "connect_channel", channel: "telegram" },
      { kind: "channel-setup", channel: "telegram" },
    );
    check({ action: "configure_skills" }, { kind: "skills-setup" });
    check({ action: "configure_search" }, { kind: "search-setup" });
    check({ action: "configure_gateway" }, { kind: "gateway-config-setup" });
    check({ action: "import_memory" }, { kind: "memory-import" });
    check({ action: "open_agent" }, { kind: "open-tui" });
    check(
      { action: "configure_model_provider", workspace: "/tmp/work" },
      { kind: "model-setup", workspace: "/tmp/work" },
    );
    check({ action: "open_setup", target: "classic" }, { kind: "open-setup", target: "classic" });
    check({ action: "open_setup", target: "search" }, { kind: "open-setup", target: "search" });
    check({ action: "open_setup", target: "gateway" }, { kind: "open-setup", target: "gateway" });
    // Non-directive results and other actions never mirror.
    expect(
      resolveSystemAgentDirectiveTransition({ args: { action: "status" }, resultText: "ok" }),
    ).toBeNull();
    expect(
      resolveSystemAgentDirectiveTransition({
        args: { action: "connect_channel", channel: "telegram" },
        resultText: "error: boom",
      }),
    ).toBeNull();
  });

  it("mirrors proposal transitions for out-of-process (CLI MCP) hosts", () => {
    const args = { action: "set_default_model", model: "openai/gpt-5.5" };
    const hash = hashSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" });

    const transition = (resultText: string, input = args) =>
      resolveSystemAgentProposalTransition({ args: input, resultText });
    const proposed = {
      proposal: hash,
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    };
    expect(transition("needs-approval: this action changes state.")).toEqual(proposed);
    expect(transition(`needs-approval:${hash}\nThis action changes state.`)).toEqual(proposed);
    // A voided approval clears it.
    expect(
      transition("approval-mismatch: this call is not the operation the user approved."),
    ).toEqual({ proposal: undefined });
    // Only the admitted host directive consumes it; generic failures are not admission.
    expect(
      resolveSystemAgentProposalTransition({
        args: { ...args, approved: true },
        resultText: "directive:approved-operation: the host will apply this action.",
      }),
    ).toEqual({ proposal: undefined });
    // A rejected second proposal must not overwrite the mirrored first
    // operation: the host keeps proposalRef untouched on a null transition.
    expect(
      resolveSystemAgentProposalTransition({
        args: { action: "config_set", path: "talk.providers.fish-audio.model", value: "s2.1-pro" },
        resultText: `proposal-conflict:${hash}\nA different operation is already staged and awaiting the user's approval.`,
      }),
    ).toBeNull();
    // Read actions and unparsable calls never touch the proposal.
    expect(
      resolveSystemAgentProposalTransition({ args: { action: "status" }, resultText: "ok" }),
    ).toBeNull();
    expect(
      resolveSystemAgentProposalTransition({ args: { action: "bogus" }, resultText: "ok" }),
    ).toBeNull();
  });
});
