import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSnapshot } from "../../config/mutate.test-support.js";
import { hashSystemAgentOperation } from "../../system-agent/operator-approval.js";
import { withSystemAgentOverviewSources } from "../../system-agent/overview.test-support.js";
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
const artifact = { action: "plugin_activate_artifact", path: "/tmp/authored-plugin.tgz" };

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

function gatewayFixture(options: Partial<SystemAgentToolOptions> = {}) {
  const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
  const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
  const tool = makeTool({ ...options, proposalRef, directiveRef });
  const approved = makeTool({ ...options, proposalRef, directiveRef, approvalArmed: true });
  const call = async (args: Record<string, unknown>, armed = false) =>
    toolText(await (armed ? approved : tool).execute("call", args));
  return { proposalRef, directiveRef, tool, call };
}

const directiveTransition = (
  args: Record<string, unknown>,
  resultText = "directive: host handoff",
) => resolveSystemAgentDirectiveTransition({ args, resultText });
const proposalTransition = (args: Record<string, unknown>, resultText: string) =>
  resolveSystemAgentProposalTransition({ args, resultText });

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

    // `health` is discoverable in the schema and advertised as a free read.
    const actionEnum = (
      tool.parameters as {
        properties: { action: { enum: string[] } };
      }
    ).properties.action.enum;
    expect(actionEnum).toContain("health");
    expect(tool.description).toMatch(/Read now:.*health/);
  });

  it("routes action:overview through the canonical overview executor", async () => {
    const runtimeConfig = {
      agents: {
        ownership: "explicit" as const,
        defaults: { model: { primary: "openai/gpt-5.2" }, systemAgent: { agentId: "main" } },
        entries: { main: {} },
      },
      gateway: { port: 19001 },
    };
    const snapshot = {
      ...createSnapshot({ sourceConfig: runtimeConfig, hash: "test-hash" }),
      raw: "{}",
    };
    const realExecutor = await vi.importActual<typeof import("../../system-agent/operations.js")>(
      "../../system-agent/operations.js",
    );
    mocks.executeSystemAgentOperation.mockImplementationOnce(
      realExecutor.executeSystemAgentOperation as unknown as typeof mocks.executeSystemAgentOperation,
    );
    const tool = createSystemAgentTool({ surface: "cli" });
    const result = await withSystemAgentOverviewSources(snapshot, async () => {
      const out = await tool.execute("t-overview", { action: "overview" });
      const text = toolText(out);
      expect(text).toContain("OpenClaw online. Little claws, typed tools.");
      expect(text).toContain("Config: valid");
      expect(text).toContain("Default agent: main");
      expect(text).toContain("Default model: openai/gpt-5.2");
      expect(text).toContain("Gateway: not reachable");
      return out;
    });
    expect(toolText(result)).not.toContain("needs-approval");
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
    const pending = tool.execute(
      "cancelled-proposal",
      { action: "config_set", path: "gateway.port", value: "19001" },
      AbortSignal.abort(new Error("Setup cancelled")),
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
    const args = { ...artifact, sha256: "a".repeat(64) };
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
    const pending = makeTool({ operatorApprovalOnly: true, proposalRef }).execute("artifact", args);
    await started.promise;
    expect(proposalRef.current).toBeUndefined();
    review.resolve({ pluginId: "authored-plugin", nativeControlUi: true, sha256: args.sha256 });
    const result = await pending;
    expect(toolText(result)).toContain("Reviewed plugin artifact");
    expect(toolText(result)).toContain("requesting session's permission policy");
    expect(proposalTransition(args, toolText(result))).toEqual({
      proposal: hashSystemAgentOperation(operation),
      operation,
    });
    const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
    await makeTool({ approvalArmed: true, proposalRef, directiveRef }).execute(
      "approved-artifact",
      { ...args, approved: true },
    );
    expect(directiveRef.current).toEqual({ kind: "approved-operation", operation });
    expect(proposalRef.current).toBeUndefined();
    expect(mocks.preparePluginArtifact).toHaveBeenCalledOnce();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("does not propose a failed artifact review or overwrite another proposal after review", async () => {
    const args = { ...artifact, sha256: "b".repeat(64) };
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
    const { proposalRef, directiveRef, call } = gatewayFixture();
    const args = { action: "set_default_model", model: "openai/gpt-5.5", approved: true };
    const expected: SystemAgentToolDirective = {
      kind: "approved-operation",
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    };
    expect(await call(args)).toContain("needs-approval");
    expect(proposalRef.current).toBeDefined();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();

    expect(await call(args, true)).toContain("directive:approved-operation:");
    expect(directiveRef.current).toEqual(expected);
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
    await call({ action: "connect_channel", channel: "telegram" }, true);
    expect(directiveRef.current).toEqual(expected);
    expect(proposalRef.current).toBeUndefined();
  });

  it("keeps the first staged config_set proposal instead of overwriting it with a second", async () => {
    const { proposalRef, call } = gatewayFixture();
    const first = await call({
      action: "config_set",
      path: "tts.providers.fish-audio.model",
      value: "s2.1-pro",
    });
    expect(first).toContain("needs-approval");
    const firstHash = proposalRef.current;
    expect(firstHash).toBeDefined();

    const second = await call({
      action: "config_set",
      path: "talk.providers.fish-audio.model",
      value: "s2.1-pro",
    });

    expect(second).toContain("proposal-conflict");
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
    expect(proposalTransition(args, toolText(result))).toEqual({
      proposal: proposalRef.current,
      operation,
    });
  });

  it("voids approval when the requested operation changes, including identical retries", async () => {
    const proposed = { action: "create_agent", agentId: "qa-writer", name: "QA Writer" };
    const changed = { ...proposed, name: "Other Writer" };
    const { proposalRef, call } = gatewayFixture({ surface: "cli" });
    await call({ ...proposed, approved: true });
    expect(await call({ ...changed, approved: true }, true)).toContain("approval-mismatch");
    expect(proposalRef.current).toBeUndefined();
    expect(await call({ ...changed, approved: true }, true)).toContain("approval-mismatch");
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

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
    const cases: Array<[Record<string, unknown>, SystemAgentToolDirective, string[]]> = [
      [
        { action: "connect_channel", channel: "Telegram" },
        { kind: "channel-setup", channel: "telegram" },
        ["directive:"],
      ],
      [{ action: "configure_skills" }, { kind: "skills-setup" }, ["directive:"]],
      [
        { action: "configure_search" },
        { kind: "search-setup" },
        ["directive:", "never ask for or repeat a credential"],
      ],
      [
        { action: "configure_gateway" },
        { kind: "gateway-config-setup" },
        ["directive:", "local Gateway configuration", "never ask for or repeat a credential"],
      ],
      [
        { action: "import_memory" },
        { kind: "memory-import" },
        ["directive:", "copy-only memory import"],
      ],
      [
        { action: "manage_model_accounts" },
        { kind: "model-accounts" },
        ["Nothing has changed yet"],
      ],
      [
        { action: "configure_model_provider", workspace: "/tmp/work" },
        { kind: "model-setup", workspace: "/tmp/work" },
        ["directive:", "protected Models sign-in guidance", "Nothing has changed"],
      ],
      [
        { action: "open_agent", agentId: "work" },
        { kind: "open-tui", agentId: "work" },
        ["directive:"],
      ],
      [
        { action: "open_setup", target: "channels", channel: "Slack" },
        { kind: "open-setup", target: "channels", channel: "slack" },
        ["directive:"],
      ],
      [
        { action: "open_setup", target: "guided" },
        { kind: "open-setup", target: "guided" },
        ["cannot run inside OpenClaw", "openclaw onboard"],
      ],
      [
        { action: "open_setup", target: "gateway" },
        { kind: "open-setup", target: "gateway" },
        ["masked terminal Gateway setup"],
      ],
    ];
    for (const [args, expected, snippets] of cases) {
      const resultText = toolText(await tool.execute("handoff", args));
      for (const snippet of snippets) {
        expect(resultText).toContain(snippet);
      }
      expect(directiveRef.current).toEqual(expected);
      expect(directiveTransition(args, resultText)).toEqual(expected);
    }
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("does not promise a delegated setup handoff", async () => {
    const args = { action: "open_setup", target: "channels" };
    const { directiveRef, call } = gatewayFixture({ operatorApprovalOnly: true });
    const text = await call(args);

    expect(text).toContain("cannot run from a delegated agent request");
    expect(directiveRef.current).toBeUndefined();
    expect(directiveTransition(args, text)).toBeNull();
    expect(mocks.executeSystemAgentOperation).not.toHaveBeenCalled();
  });

  it("mirrors directive transitions for out-of-process (CLI MCP) hosts", () => {
    const check = (
      args: Record<string, unknown>,
      expected: SystemAgentToolDirective,
      resultText = "directive: host handoff",
    ) => expect(directiveTransition(args, resultText)).toEqual(expected);
    check(
      { action: "config_set", path: "gateway.port", value: "19001", approved: true },
      {
        kind: "approved-operation",
        operation: { kind: "config-set", path: "gateway.port", value: "19001" },
      },
      "directive:approved-operation: the host will apply this action.",
    );
    check({ action: "open_agent" }, { kind: "open-tui" });
    check({ action: "open_setup", target: "classic" }, { kind: "open-setup", target: "classic" });
    check({ action: "open_setup", target: "search" }, { kind: "open-setup", target: "search" });
    expect(directiveTransition({ action: "status" }, "ok")).toBeNull();
    expect(
      directiveTransition({ action: "connect_channel", channel: "telegram" }, "error: boom"),
    ).toBeNull();
  });

  it("mirrors proposal transitions for out-of-process (CLI MCP) hosts", () => {
    const args = { action: "set_default_model", model: "openai/gpt-5.5" };
    const hash = hashSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" });

    const transition = (resultText: string, input: Record<string, unknown> = args) =>
      proposalTransition(input, resultText);
    const proposed = {
      proposal: hash,
      operation: { kind: "set-default-model", model: "openai/gpt-5.5" },
    };
    expect(transition("needs-approval: this action changes state.")).toEqual(proposed);
    expect(transition(`needs-approval:${hash}\nThis action changes state.`)).toEqual(proposed);
    expect(
      transition("approval-mismatch: this call is not the operation the user approved."),
    ).toEqual({ proposal: undefined });
    expect(
      transition("directive:approved-operation: the host will apply this action.", {
        ...args,
        approved: true,
      }),
    ).toEqual({ proposal: undefined });
    expect(
      transition(
        `proposal-conflict:${hash}\nA different operation is already staged and awaiting the user's approval.`,
        { action: "config_set", path: "talk.providers.fish-audio.model", value: "s2.1-pro" },
      ),
    ).toBeNull();
    expect(transition("ok", { action: "status" })).toBeNull();
    expect(transition("ok", { action: "bogus" })).toBeNull();
  });
});
