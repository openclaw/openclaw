import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SystemAgentTurnRunner } from "./agent-turn.js";
import {
  operationMocks,
  fakeOverviewLoader,
  classifySystemAgentApprovalText,
  mocks,
  useTempStateDir,
  SystemAgentChatEngine,
  SystemAgentInferenceUnavailableError,
  expectDefined,
  hashSystemAgentOperation,
} from "./chat-engine.test-support.js";
import { describeSystemAgentPersistentOperation } from "./operations.js";
import * as operations from "./operations.js";

const nativeExecuteOperation = operations.executeSystemAgentOperation;

function mockApprovedOperation() {
  vi.spyOn(operations, "executeSystemAgentOperation").mockImplementation((...args) =>
    args[2]?.approved === true
      ? Promise.resolve({ applied: true })
      : nativeExecuteOperation(...args),
  );
}

function createEngine(options: ConstructorParameters<typeof SystemAgentChatEngine>[0] = {}) {
  const engine = new SystemAgentChatEngine({
    ...options,
    deps: { loadOverview: fakeOverviewLoader(), ...options.deps },
  });
  onTestFinished(() => engine.dispose());
  return engine;
}

describe("SystemAgentChatEngine approval", () => {
  it("records the delegated requester before hashing a model-tool proposal", async () => {
    mockApprovedOperation();
    const unrecordedOperation = {
      kind: "create-agent" as const,
      agentId: "researcher",
      workspace: "/tmp/researcher",
    };
    const unrecordedHash = hashSystemAgentOperation(unrecordedOperation);
    const engine = createEngine({
      operatorApprovalOnly: true,
      requesterAgentId: "research",
      runAgentTurn: async ({ session }) => {
        session.proposalRef.current = unrecordedHash;
        session.proposalRef.operation = unrecordedOperation;
        return { text: "Creation needs operator approval." };
      },
    });

    await engine.handle("Create a research agent.");
    const proposal = expectDefined(engine.getPendingOperatorProposal(), "delegated proposal");

    expect(proposal.operation).toEqual({
      ...unrecordedOperation,
      requesterAgentId: "research",
    });
    expect(proposal.hash).not.toBe(unrecordedHash);
    expect(describeSystemAgentPersistentOperation(proposal.operation)).toContain(
      "requested by agent research",
    );
    expect(await engine.resolveOperatorApproval("allow-once", unrecordedHash)).toBeNull();
    expect(await engine.resolveOperatorApproval("allow-once", proposal.hash)).not.toBeNull();
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it.each(["allow-once", null] as const)(
    "resolves delegated persistent writes only from the operator decision %s",
    async (decision) => {
      useTempStateDir();
      const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
      const proposalHash = hashSystemAgentOperation(operation);
      const armed: boolean[] = [];
      const observedInputs: string[] = [];
      const runConfigSet = operationMocks.runConfigSet.mockResolvedValue(undefined);
      const engine = new SystemAgentChatEngine({
        operatorApprovalOnly: true,
        runAgentTurn: async (params) => {
          armed.push(params.approvalArmed);
          observedInputs.push(params.input);
          if (observedInputs.length === 1) {
            params.session.proposalRef.current = proposalHash;
            params.session.proposalRef.operation = operation;
          }
          return { text: "Change ready." };
        },
        deps: { loadOverview: fakeOverviewLoader() },
      });

      await engine.handle("Change port.");
      const agentApproval = await engine.handle("yes");

      expect(agentApproval.text).toContain("Approval pending");
      expect(armed).toEqual([false]);
      expect(runConfigSet).not.toHaveBeenCalled();

      const wrongProposal = await engine.resolveOperatorApproval("allow-once", "wrong-hash");
      expect(wrongProposal).toBeNull();
      expect(runConfigSet).not.toHaveBeenCalled();

      const applied = await engine.resolveOperatorApproval(decision, proposalHash);
      const duplicate = await engine.resolveOperatorApproval(decision, proposalHash);
      await engine.handle("what changed?");

      expect(armed).toEqual([false, false]);
      expect(duplicate).toBeNull();
      expect(observedInputs[1]).toContain("[proposal-resolved]");
      if (decision === "allow-once") {
        expect(runConfigSet).toHaveBeenCalledOnce();
        expect(runConfigSet).toHaveBeenCalledWith({
          path: "gateway.port",
          value: "19001",
          cliOptions: {},
          runtime: expect.objectContaining({ exit: expect.any(Function) }),
          throwOnError: false,
        });
        expect(applied?.text).toContain("[openclaw] done: config.set");
        expect(observedInputs[1]).toContain("was approved");
      } else {
        expect(runConfigSet).not.toHaveBeenCalled();
        expect(applied?.text).toBe("Denied. No change.");
        expect(observedInputs[1]).toContain("was declined");
      }
      expect(observedInputs[1]).not.toContain("host-seeded");
    },
  );

  it.each([
    {
      origin: "custodian",
      requesterAgentId: undefined,
      expectedCreatorAgentId: "openclaw",
      expectedDescription: "create agent researcher with workspace /tmp/researcher",
    },
    {
      origin: "delegated agent",
      requesterAgentId: "research",
      expectedCreatorAgentId: "research",
      expectedDescription:
        "create agent researcher with workspace /tmp/researcher, requested by agent research",
    },
  ])(
    "hatches an agent requested by the $origin with approval-bound provenance",
    async ({ requesterAgentId, expectedCreatorAgentId, expectedDescription }) => {
      useTempStateDir();
      const createAgent = operationMocks.createAgent.mockImplementation(async () => ({
        status: "created" as const,
        agentId: "researcher",
        name: "researcher",
        workspace: "/tmp/researcher",
        agentDir: "/tmp/agent-researcher",
        bootstrapPending: true,
        config: {},
        configPath: "/tmp/openclaw.json",
      }));
      const engine = new SystemAgentChatEngine({
        runAgentTurn: async () => ({ text: "noted" }),
        classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
        deps: { loadOverview: fakeOverviewLoader() },
        ...(requesterAgentId ? { requesterAgentId, operatorApprovalOnly: true } : {}),
      });
      engine.propose({
        kind: "create-agent",
        agentId: "researcher",
        workspace: "/tmp/researcher",
      });
      const proposal = expectDefined(engine.getPendingOperatorProposal(), "create-agent proposal");

      expect(proposal.operation).toEqual({
        kind: "create-agent",
        agentId: "researcher",
        workspace: "/tmp/researcher",
        ...(requesterAgentId ? { requesterAgentId } : {}),
      });
      expect(describeSystemAgentPersistentOperation(proposal.operation)).toBe(expectedDescription);

      const reply = expectDefined(
        await engine.resolveOperatorApproval("allow-once", proposal.hash),
        "approved create-agent reply",
      );

      expect(createAgent).toHaveBeenCalledWith({
        entry: { id: "researcher" },
        workspace: "/tmp/researcher",
        provenance: { createdVia: "agent", creatorAgentId: expectedCreatorAgentId },
      });
      expect(reply.action).toBe("open-tui");
      expect(reply.handoff).toMatchObject({
        kind: "open-tui",
        agentId: "researcher",
        agentDraft: "hatch",
      });
    },
  );

  it("stays in setup when post-write verification flags the config", async () => {
    useTempStateDir();
    operationMocks.verifyInferenceConfig.mockImplementation(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    let applied = false;
    const applySetup = operationMocks.applySetup.mockImplementation(async () => {
      applied = true;
      return {
        configPath: "/tmp/openclaw.json",
        configHashBefore: "before",
        configHashAfter: "after",
        bootstrapPending: true,
        workspaceReady: true,
        gateway: { status: "ready" as const, action: "reused" as const },
        lines: ["Workspace: /tmp/hatch-work"],
      };
    });
    // The written config turns out invalid: post-write verification must hold
    // the user in setup instead of hatching into an agent that cannot answer.
    // Reads stay valid through preflight/apply and flip only after the write.
    const validSnapshot = mocks.readConfigFileSnapshot.getMockImplementation()!;
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      const snapshot = await validSnapshot();
      return applied
        ? ({
            ...snapshot,
            valid: false,
            issues: [{ path: "agents", message: "broken" }],
          } as never)
        : snapshot;
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({ text: "repair suggestion" }),
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });

    const reply = await engine.handle("yes");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).not.toContain("Your agent is hatching");
  });

  it("keeps provider setup non-mutating and directs the operator to Models", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => ({ text: "noted" }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("configure model provider workspace /tmp/gateway-work");

    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.sensitive).toBeUndefined();
    expect(reply.text).toContain("Settings → Models → Connect provider");
    expect(reply.text).toContain("Connecting another provider does not select it");
    expect(reply.text).not.toContain("openclaw onboard");
  });

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = operationMocks.runConfigSet.mockResolvedValue(undefined);
    const engine = new SystemAgentChatEngine();
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("no thanks");
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(reply.text).toContain("Skipped");
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it("voids an agent-loop proposal on decline and lets the AI acknowledge", async () => {
    let observedProposalOnSecondTurn: string | undefined = "sentinel";
    const runAgentTurn = vi.fn(
      async (params: { session: { proposalRef: { current?: string } } }) => {
        if (runAgentTurn.mock.calls.length === 1) {
          params.session.proposalRef.current = "registered-operation";
          return { text: "I can change that after your approval." };
        }
        observedProposalOnSecondTurn = params.session.proposalRef.current;
        return { text: "Okay, leaving it as is." };
      },
    );
    const engine = createEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });

    await engine.handle("change the model");
    const declined = await engine.handle("no thanks");

    // The decline voids the registered hash before the AI turn, so a later
    // generic approval can never arm the stale mutation.
    expect(observedProposalOnSecondTurn).toBeUndefined();
    expect(declined.text).toContain("leaving it as is");
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("clears a stale host proposal once the agent loop owns the conversation", async () => {
    const operation = { kind: "config-set", path: "gateway.port", value: "19002" } as const;
    const hash = hashSystemAgentOperation(operation);
    const runAgentTurn = vi.fn(async (params: Parameters<SystemAgentTurnRunner>[0]) => {
      params.session.proposalRef.current = hash;
      params.session.proposalRef.operation = operation;
      return { text: "loop reply" };
    });
    const engine = createEngine({
      runAgentTurn,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("actually, tell me about workspaces first");

    expect(engine.getPendingOperatorProposal()).toEqual({ operation, hash });
    await engine.handle("yes");

    expect(runAgentTurn.mock.calls.map(([params]) => params.approvalArmed)).toEqual([false, true]);
    expect(runAgentTurn.mock.calls[1]?.[0].input).not.toContain("host-seeded");
  });

  it("keeps a host setup proposal across approval reads and follow-up questions", async () => {
    mockApprovedOperation();
    const operation = {
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    } as const;
    const proposal = { operation, hash: hashSystemAgentOperation(operation) };
    const runAgentTurn = vi.fn(async (_params: Parameters<SystemAgentTurnRunner>[0]) => ({
      text: "A workspace is where your agent keeps its project files.",
    }));
    const engine = createEngine({
      runAgentTurn,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });
    engine.propose(operation);

    expect(engine.getPendingOperatorProposal()).toEqual(proposal);
    expect(engine.getPendingOperatorProposal()).toEqual(proposal);

    await engine.handle("what does workspace mean?");

    expect(engine.getPendingOperatorProposal()).toEqual(proposal);
    expect(runAgentTurn.mock.calls[0]?.[0].input).toContain('"model":"openai/gpt-5.5"');
    expect(runAgentTurn.mock.calls[0]?.[0].input).toContain("Keep the verified model");

    await engine.handle("yes");

    expect(runAgentTurn).toHaveBeenCalledOnce();
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it("keeps a host-resolution marker queued across a failed turn", async () => {
    mockApprovedOperation();
    const observedInputs: string[] = [];
    const runAgentTurn = vi.fn(async (params: { input: string }) => {
      observedInputs.push(params.input);
      return observedInputs.length === 1 ? null : { text: "native reply" };
    });
    const engine = createEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("yes");
    await expect(engine.handle("what next?")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    await engine.handle("try the native session again");
    await engine.handle("and now?");

    expect(observedInputs).toHaveLength(3);
    expect(observedInputs[0]).toContain("was approved");
    expect(observedInputs[1]).toContain("was approved");
    expect(observedInputs[2]).not.toContain("proposal-resolved");
  });

  it.each([
    {
      path: 'channels.synology-chat.accounts["prod.guild"].webhookUrl',
      value: "https://gateway.example/webhook/synology?access_token=very-secret",
    },
    {
      path: "plugins.entries.codex.config.appServer.headers.Authorization",
      value: "Bearer very-secret",
    },
    {
      path: "channels.synology-chat",
      value: '{ webhookUrl: "https://gateway.example/webhook/synology?access_token=very-secret" }',
    },
  ])(
    "keeps hint-sensitive config writes at $path away from model paths and history",
    async ({ path, value }) => {
      useTempStateDir();
      const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({ text: "still pending" }));
      const runConfigSet = operationMocks.runConfigSet.mockResolvedValue(undefined);
      const engine = new SystemAgentChatEngine({
        runAgentTurn,
        deps: { loadOverview: fakeOverviewLoader() },
      });

      const proposed = await engine.handle(`config set ${path} ${value}`);

      expect(runAgentTurn).not.toHaveBeenCalled();
      expect(proposed.text).toContain("<redacted>");
      expect(proposed.text).not.toContain("very-secret");
      expect(engine.getPendingOperatorProposal()?.operation).toEqual({
        kind: "config-set",
        path,
        value,
      });

      await engine.handle("what is that setting?");
      expect(runAgentTurn.mock.calls[0]?.[0].input).not.toContain("very-secret");
      expect(runAgentTurn.mock.calls[0]?.[0].input).toContain("<redacted>");

      const applied = await engine.handle("yes");
      expect(runConfigSet).toHaveBeenCalledOnce();
      expect(applied.text).toContain("[openclaw] done: config.set");
      expect(JSON.stringify(engine.historySince(0))).not.toContain("very-secret");
      expect(JSON.stringify(engine.historySince(0))).toContain("<redacted secret>");
    },
  );

  it("keeps valid SecretRef ids out of pending context and later history", async () => {
    const rawRef = "123:actual-gateway-token";
    const observedInputs: string[] = [];
    const engine = new SystemAgentChatEngine({
      classifyApproval: async () => "other",
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "still pending" };
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle(`config set-ref gateway.auth.token exec ${rawRef}`);
    expect(proposed.text).not.toContain(rawRef);
    expect(observedInputs).toEqual([]);
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source: "exec",
      id: rawRef,
    });
    await engine.handle("what will this change?");

    expect(observedInputs.join("\n")).not.toContain(rawRef);
    expect(observedInputs.join("\n")).toContain("<redacted>");
    expect(JSON.stringify(engine.historySince(0))).not.toContain(rawRef);
  });

  it("keeps malformed config read paths off model and history", async () => {
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle('config schema gateway.auth["token=abcDEF123"]');

    expect(reply.text).toContain("Invalid config path");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(engine.historySince(0))).not.toContain("abcDEF123");
  });

  it("redacts vulnerable config command text when persisted history is seeded", () => {
    const engine = new SystemAgentChatEngine({
      deps: { loadOverview: fakeOverviewLoader() },
    });

    engine.seedHistory([
      { role: "user", text: "config set-ref gateway.auth.token exec 123:actual-gateway-token" },
      { role: "user", text: "config get gateway.auth.tokenabcDEF123" },
    ]);

    expect(JSON.stringify(engine.historySince(0))).not.toContain("actual-gateway-token");
    expect(JSON.stringify(engine.historySince(0))).not.toContain("abcDEF123");
  });

  it.each([
    "config set gateway.auth..token very-secret",
    "config set plugins.entries.codex.config.appServer.headers.Authorization=Bearer-abc please",
    "config set-ref gateway.auth.tokenabcDEF123 env GATEWAY_TOKEN",
    "config set-ref gateway.auth.token env 123:actual-gateway-token",
  ])("keeps malformed sensitive config write %s away from every model path", async (command) => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle(command);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(proposed.text).toContain("Invalid config path");
    expect(proposed.text).not.toContain("very-secret");
    expect(proposed.text).not.toContain("abcDEF123");
    expect(proposed.text).not.toContain("actual-gateway-token");
    expect(engine.getPendingOperatorProposal()).toBeNull();

    await engine.handle("did that work?");

    const history = engine.historySince(0);
    const userTurns = history.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns.some((text) => text.includes("very-secret"))).toBe(false);
    expect(userTurns.some((text) => text.includes("abcDEF123"))).toBe(false);
    expect(userTurns.some((text) => text.includes("Bearer-abc"))).toBe(false);
    expect(userTurns.some((text) => text.includes("actual-gateway-token"))).toBe(false);
    expect(userTurns.some((text) => text.includes("<redacted secret>"))).toBe(true);
  });

  it.each([
    "config set plugins.entries.missing.config.opaque.abcDEF123 please",
    'config set channels.synology-chat.accounts["prod.guild"].webhookUrl.abcDEF123 please',
  ])(
    "keeps sensitive dynamic or unknown-owner path %s out of model paths, responses, and history",
    async (command) => {
      const runAgentTurn = vi.fn(async () => ({ text: "noted" }));
      const engine = new SystemAgentChatEngine({
        runAgentTurn,
        classifyApproval: async () => "other",
        deps: { loadOverview: fakeOverviewLoader() },
      });

      const proposed = await engine.handle(command);
      expect(proposed.text).not.toContain("abcDEF123");
      expect(proposed.text).not.toContain("Bearer-abc");
      expect(runAgentTurn).not.toHaveBeenCalled();

      await engine.handle("no");
      await engine.handle("did that work?");
      const history = engine.historySince(0);
      expect(history.some((turn) => turn.text.includes("abcDEF123"))).toBe(false);
      expect(history.some((turn) => turn.text.includes("Bearer-abc"))).toBe(false);
    },
  );
});
