import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { SystemAgentTurnRunner } from "./agent-turn.js";
import {
  operationMocks,
  fakeOverviewLoader,
  createChatEngine,
  SystemAgentChatEngine,
  setupResult,
  classifySystemAgentApprovalText,
  mocks,
  useTempStateDir,
  SystemAgentInferenceUnavailableError,
  expectDefined,
  hashSystemAgentOperation,
  inferenceConfig,
  configSnapshot,
  createAmbientVerifiedBinding,
  CANCEL_HINT,
  countCancelHints,
  SystemAgentWizardAnswerError,
  type OpenClawConfig,
  type WizardPrompter,
} from "./chat-engine.test-support.js";
import * as hostedSetup from "./hosted-setup.runtime.js";
import { describeSystemAgentPersistentOperation } from "./operations.js";
import * as operations from "./operations.js";

const createEngine = (options: Parameters<typeof createChatEngine>[0] = {}) =>
  createChatEngine(options, true);

const nativeExecuteOperation = operations.executeSystemAgentOperation;

const createWizardEngine = (options: ConstructorParameters<typeof SystemAgentChatEngine>[0] = {}) =>
  createChatEngine({ runAgentTurn: async () => null, ...options });

function tokenWizard(sensitive = false, initialValue?: string) {
  return async (_channel: string, prompter: WizardPrompter) => {
    await prompter.text({
      message: "Bot token",
      ...(sensitive ? { sensitive: true } : {}),
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    return "applied" as const;
  };
}

async function startGatewayWizard(
  options: ConstructorParameters<typeof SystemAgentChatEngine>[0] = {},
  run: typeof hostedSetup.runHostedChannelSetup = tokenWizard(),
) {
  const { engine, prompt } = await startWizard(run, { surface: "gateway", ...options });
  return {
    engine,
    prompt,
    stepId: expectDefined(prompt.step?.id, "expected an active wizard step"),
  };
}

async function startWizard(
  run: typeof hostedSetup.runHostedChannelSetup,
  options: ConstructorParameters<typeof SystemAgentChatEngine>[0] = {},
  command = "connect telegram",
) {
  vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(run);
  const engine = createWizardEngine(options);
  return { engine, prompt: await engine.handle(command) };
}

describe("SystemAgentChatEngine wizard", () => {
  it.each([false, undefined])(
    "recommends the confirm option for initial value %s",
    async (initialValue) => {
      let enabled: boolean | undefined;
      const { engine, prompt } = await startWizard(async (_channel, prompter) => {
        enabled = await prompter.confirm({ message: "Enable delegated auth?", initialValue });
        return "applied";
      });
      expect(prompt.question).toEqual({
        id: expect.any(String),
        header: "Confirm",
        question: "Enable delegated auth?",
        options: [
          { label: "Yes", reply: "yes", ...(initialValue === false ? {} : { recommended: true }) },
          { label: "No", reply: "no", ...(initialValue === false ? { recommended: true } : {}) },
        ],
      });
      await engine.handle(initialValue === false ? "no" : "yes");
      expect(enabled).toBe(initialValue !== false);
    },
  );

  it("rejects non-decimal menu numbers in hosted wizard choices", async () => {
    useTempStateDir();
    const runs: unknown[] = [];
    vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(
      async (_channel, prompter) => {
        runs.push(
          await prompter.select({
            message: "DM mode",
            options: [
              { value: "pair", label: "Pairing" },
              { value: "open", label: "Open" },
            ],
          }),
        );
        runs.push(
          await prompter.multiselect({
            message: "Features",
            options: [
              { value: "alerts", label: "Alerts" },
              { value: "logs", label: "Logs" },
            ],
          }),
        );
        return "applied";
      },
    );
    const engine = createWizardEngine();
    expect((await engine.handle("connect telegram")).text).toContain("1. Pairing");
    expect((await engine.handle("1e0")).text).toContain("I could not match that answer.");
    expect(runs).toEqual([]);
    expect((await engine.handle("1")).text).toContain("1. Alerts");
    expect((await engine.handle("0x1")).text).toContain("I could not match that answer.");
    expect(await engine.handle("1,2")).toHaveProperty(
      "text",
      expect.stringContaining("telegram is configured"),
    );
    expect(runs).toEqual(["pair", ["alerts", "logs"]]);
  });

  it("routes sensitive CLI wizard prompts to the masked channel setup flow", async () => {
    useTempStateDir();
    const { engine, prompt: reply } = await startWizard(tokenWizard(true), { surface: "cli" });
    expect(reply.text).toContain("Sensitive input is not accepted");
    expect(reply.text).toContain("openclaw channels add --channel telegram");
    expect(reply.sensitive).toBeUndefined();

    const handoff = await engine.handle("open channel wizard");
    expect(handoff.action).toBe("open-setup");
    expect(handoff.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "telegram",
    });

    const channelRequired = await engine.handle("open channel wizard");
    expect(channelRequired.action).toBe("none");
    expect(channelRequired.text).toContain("Which channel");

    const selectedChannel = await engine.handle("slack");
    expect(selectedChannel.action).toBe("open-setup");
    expect(selectedChannel.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
  });

  it("clears a sensitive channel before a different wizard session starts", async () => {
    vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(tokenWizard(true));
    vi.spyOn(hostedSetup, "runHostedSkillsSetup").mockResolvedValueOnce("applied");
    const engine = createWizardEngine({
      surface: "cli",
    });

    const sensitive = await engine.handle("connect telegram");
    expect(sensitive.text).toContain("masked terminal wizard for telegram");
    await engine.handle("configure skills");

    const handoff = await engine.handle("open channel wizard");
    expect(handoff.action).toBe("none");
    expect(handoff.handoff).toBeUndefined();
    expect(handoff.text).toContain("Which channel");
  });

  it("routes inference setup out of both CLI and gateway sessions", async () => {
    const cli = createWizardEngine({ surface: "cli" });
    for (const command of ["open setup wizard", "open classic wizard"]) {
      const cliReply = await cli.handle(command);
      expect(cliReply.action).toBe("none");
      expect(cliReply.handoff).toBeUndefined();
      expect(cliReply.text).toContain("run `openclaw onboard`");
    }

    const gateway = createWizardEngine({ surface: "gateway" });
    const gatewayReply = await gateway.handle("open setup wizard");
    expect(gatewayReply.action).toBe("none");
    expect(gatewayReply.handoff).toBeUndefined();
    expect(gatewayReply.text).toContain("Settings");
    expect(gatewayReply.text).toContain("change providers from a shell");
    expect(gatewayReply.text).toContain("machine running OpenClaw");
    expect(gatewayReply.text).not.toContain("does the same job");
    expect(gatewayReply.text).not.toContain("Exit OpenClaw");
  });

  it("keeps hosted-wizard validation errors on the current prompt", async () => {
    useTempStateDir();
    const { engine, prompt } = await startWizard(async (_channel, prompter) => {
      await prompter.text({
        message: "Port",
        validate: (value) => (value === "18789" ? undefined : "Enter port 18789"),
      });
      return "applied";
    });
    expect(prompt.text).toContain("Port");
    const invalid = await engine.handle("banana");
    expect(invalid.text).toContain("Enter port 18789");
    expect(invalid.text).toContain("Port");
    expect(countCancelHints(invalid.text)).toBe(1);
    expect(invalid.text.endsWith(CANCEL_HINT)).toBe(true);
    const done = await engine.handle("18789");
    expect(done.text).toContain("telegram is configured");
  });

  it("hints cancel once per message, only while a step awaits an answer", async () => {
    useTempStateDir();
    const { engine, prompt } = await startWizard(async (_channel, prompter) => {
      await prompter.note("Open the linked-devices screen.", "Step 1");
      await prompter.note("Scan the code shown next.", "Step 2");
      await prompter.note("Keep the phone online.", "Step 3");
      await prompter.text({ message: "Phone number" });
      await prompter.note("Linked.", "Step 4");
      return "applied";
    });
    expect(prompt.text).toContain("Step 3");
    expect(prompt.text).toContain("Phone number");
    expect(countCancelHints(prompt.text)).toBe(1);
    expect(prompt.text.endsWith(CANCEL_HINT)).toBe(true);
    expect(engine.historySince(0).at(-1)).toEqual({ role: "assistant", text: prompt.text });

    const done = await engine.handle("+15551230000");
    expect(done.text).toContain("Step 4");
    expect(done.text).toContain("telegram is configured");
    expect(countCancelHints(done.text)).toBe(0);
  });

  it("voids a stale host proposal before an exact wizard, including cancellation", async () => {
    vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(tokenWizard());
    const runConfigSet = operationMocks.runConfigSet.mockResolvedValue(undefined);
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => ({
      text: params.approvalArmed ? "unexpected approval" : "No pending change.",
    }));
    const engine = createWizardEngine({
      runAgentTurn,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const prompt = await engine.handle("connect discord");
    expect(prompt.text).toContain("Bot token");
    expect(countCancelHints(prompt.text)).toBe(1);
    const cancelled = await engine.handle("cancel");
    const laterApproval = await engine.handle("yes");

    expect(cancelled.text).toContain("cancelled");
    expect(countCancelHints(cancelled.text)).toBe(0);
    expect(engine.getPendingOperatorProposal()).toBeNull();
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(runAgentTurn.mock.calls.at(-1)?.[0]?.approvalArmed).toBe(false);
    expect(laterApproval.text).toContain("No pending change");
  });

  it("voids a stale agent proposal after an exact wizard completes", async () => {
    useTempStateDir();
    vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(tokenWizard());
    const armed: boolean[] = [];
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => {
      armed.push(params.approvalArmed);
      if (armed.length === 1) {
        params.session.proposalRef.current = "stale-operation";
      }
      return { text: "No pending change." };
    });
    const engine = createWizardEngine({
      runAgentTurn,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });

    await engine.handle("prepare a change for me");
    await engine.handle("connect telegram");
    const done = await engine.handle("123:abc");
    await engine.handle("yes");

    expect(done.text).toContain("telegram is configured");
    expect(armed).toEqual([false, false]);
  });

  it("strips a sensitive step's prefilled value but keeps a plain one", async () => {
    useTempStateDir();
    const { prompt: secret } = await startGatewayWizard(
      {},
      tokenWizard(true, "123456:REAL-SECRET"),
    );
    expect(secret.step?.sensitive).toBe(true);
    expect(secret.step).not.toHaveProperty("initialValue");
    expect(JSON.stringify(secret)).not.toContain("REAL-SECRET");

    const { prompt: plain } = await startGatewayWizard(
      {},
      tokenWizard(false, "123456:REAL-SECRET"),
    );
    expect(plain.step?.initialValue).toBe("123456:REAL-SECRET");
  });

  it("omits the wizard step outside an awaiting hosted wizard", async () => {
    useTempStateDir();
    vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(tokenWizard());
    const engine = createWizardEngine({
      surface: "gateway",
      runAgentTurn: async () => ({ text: "*click* Everything looks healthy." }),
    });

    const ordinary = await engine.handle("how is my setup looking?");
    expect(ordinary.step).toBeUndefined();

    const awaiting = await engine.handle("connect telegram");
    expect(awaiting.step?.type).toBe("text");
    expect(awaiting.text).toContain("Bot token");
    expect(awaiting.question).toBeUndefined();
    expect(awaiting.sensitive).toBeUndefined();
    expect(awaiting.wizardInputPending).toBe(true);

    const done = await engine.handle("123:abc");
    expect(done.text).toContain("telegram is configured");
    expect(done.step).toBeUndefined();
  });

  it("submits a typed answer directly and records the server-owned option label", async () => {
    useTempStateDir();
    let selected: unknown;
    const { engine, stepId } = await startGatewayWizard({}, async (_channel, prompter) => {
      selected = await prompter.select({
        message: "Choose one",
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      });
      return "applied";
    });

    await engine.answerWizard({ stepId, value: "beta" });

    expect(selected).toBe("beta");
    expect(engine.historySince(0)).toContainEqual({ role: "user", text: "Beta" });
  });

  it("cancels the local hosted wizard after its inference binding drifts", async () => {
    useTempStateDir();
    const baseConfig = inferenceConfig();
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig: OpenClawConfig = baseConfig;
    const configModule = await import("../config/config.js");
    vi.mocked(configModule.readConfigFileSnapshot).mockImplementation(async () =>
      configSnapshot(currentConfig),
    );
    const { engine, stepId } = await startGatewayWizard({
      verifiedInference,
    });
    currentConfig = changedConfig;
    const cancelled = await engine.cancelWizard({ stepId });

    expect(cancelled.text).toContain("cancelled");
    expect(cancelled.step).toBeUndefined();
  });

  it("rejects a stale typed cancel without changing the active step", async () => {
    useTempStateDir();
    const { engine, stepId } = await startGatewayWizard();
    await expect(engine.cancelWizard({ stepId: "stale-step" })).rejects.toBeInstanceOf(
      SystemAgentWizardAnswerError,
    );
    const cancelled = await engine.cancelWizard({ stepId });

    expect(cancelled.text).toContain("cancelled");
    expect(cancelled.step).toBeUndefined();
    expect(cancelled.wizardInputPending).toBeUndefined();
    expect(engine.historySince(0)).toContainEqual({ role: "user", text: "Cancel" });
  });

  it("rejects a stale structured answer without changing the active step", async () => {
    useTempStateDir();
    const { engine, stepId } = await startGatewayWizard();
    await expect(
      engine.answerWizard({ stepId: "stale-step", value: "ignored" }),
    ).rejects.toBeInstanceOf(SystemAgentWizardAnswerError);
    const done = await engine.answerWizard({ stepId, value: "123:abc" });

    expect(done.step).toBeUndefined();
    expect(JSON.stringify(engine.historySince(0))).not.toContain("ignored");
  });

  it("redacts a sensitive structured answer from engine history", async () => {
    useTempStateDir();
    const { engine, stepId } = await startGatewayWizard({}, tokenWizard(true));
    await engine.answerWizard({ stepId, value: "raw-secret-value" });

    expect(engine.historySince(0)).toContainEqual({ role: "user", text: "<redacted secret>" });
    expect(JSON.stringify(engine.historySince(0))).not.toContain("raw-secret-value");
  });
});

function mockApprovedOperation() {
  vi.spyOn(operations, "executeSystemAgentOperation").mockImplementation((...args) =>
    args[2]?.approved === true
      ? Promise.resolve({ applied: true })
      : nativeExecuteOperation(...args),
  );
}

describe("SystemAgentChatEngine approval", () => {
  it.each([
    [undefined, "host"],
    ["research", "host"],
    ["research", "model"],
  ] as const)(
    "hatches a %s requester from %s with approval-bound provenance",
    async (requesterAgentId, source) => {
      useTempStateDir();
      const operation = {
        kind: "create-agent" as const,
        agentId: "researcher",
        workspace: "/tmp/researcher",
      };
      const unrecordedHash = hashSystemAgentOperation(operation);
      const createAgent = operationMocks.createAgent.mockResolvedValue({
        status: "created",
        agentId: "researcher",
        name: "researcher",
        workspace: "/tmp/researcher",
        agentDir: "/tmp/agent-researcher",
        bootstrapPending: true,
        config: {},
        configPath: "/tmp/openclaw.json",
      });
      const engine = createChatEngine(
        {
          ...(requesterAgentId ? { requesterAgentId, operatorApprovalOnly: true } : {}),
          classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
          runAgentTurn: async ({ session }) => {
            session.proposalRef.current = unrecordedHash;
            session.proposalRef.operation = operation;
            return { text: "Creation needs operator approval." };
          },
        },
        source === "model",
      );
      if (source === "model") {
        await engine.handle("Create a research agent.");
      } else {
        engine.propose(operation);
      }
      const proposal = expectDefined(engine.getPendingOperatorProposal(), "creation proposal");
      expect(proposal.operation).toEqual({
        ...operation,
        ...(requesterAgentId ? { requesterAgentId } : {}),
      });
      expect(describeSystemAgentPersistentOperation(proposal.operation)).toBe(
        "create agent researcher with workspace /tmp/researcher" +
          (requesterAgentId ? ", requested by agent research" : ""),
      );
      if (source === "model") {
        expect(proposal.hash).not.toBe(unrecordedHash);
        expect(await engine.resolveOperatorApproval("allow-once", unrecordedHash)).toBeNull();
      }
      const reply = expectDefined(
        await engine.resolveOperatorApproval("allow-once", proposal.hash),
        "approved creation",
      );
      expect(createAgent).toHaveBeenCalledWith({
        entry: { id: "researcher" },
        workspace: "/tmp/researcher",
        provenance: { createdVia: "agent", creatorAgentId: requesterAgentId ?? "openclaw" },
      });
      expect(reply.action).toBe("open-tui");
      expect(reply.handoff).toMatchObject({
        kind: "open-tui",
        agentId: "researcher",
        agentDraft: "hatch",
      });
      expect(engine.getPendingOperatorProposal()).toBeNull();
    },
  );

  it.each(["allow-once", null] as const)(
    "resolves delegated persistent writes only from the operator decision %s",
    async (decision) => {
      useTempStateDir();
      const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
      const proposalHash = hashSystemAgentOperation(operation);
      const armed: boolean[] = [];
      const observedInputs: string[] = [];
      const runConfigSet = operationMocks.runConfigSet.mockResolvedValue(undefined);
      const engine = createChatEngine({
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

  it.each([false, true])(
    "hatches after setup only when written config is valid: %s",
    async (valid) => {
      useTempStateDir();
      operationMocks.verifyInferenceConfig.mockResolvedValue({
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 100,
      });
      let applied = false;
      const applySetup = operationMocks.applySetup.mockImplementation(async () => {
        applied = true;
        return setupResult();
      });
      if (!valid) {
        // Flip only after the write: preflight succeeds, but hatching must not.
        const validSnapshot = mocks.readConfigFileSnapshot.getMockImplementation()!;
        mocks.readConfigFileSnapshot.mockImplementation(async () => {
          const snapshot = await validSnapshot();
          return applied
            ? { ...snapshot, valid: false, issues: [{ path: "agents", message: "broken" }] }
            : snapshot;
        });
      }
      const engine = createChatEngine({
        ...(valid ? { surface: "gateway" as const } : {}),
        runAgentTurn: async () => (valid ? null : { text: "repair suggestion" }),
        classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
        deps: { loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }) },
      });
      engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });
      const reply = await engine.handle("yes");
      expect(applySetup).toHaveBeenCalledOnce();
      if (valid) {
        expect(reply.action).toBe("open-tui");
        expect(reply.agentDraft).toBe("hatch");
        expect(reply.handoff).toMatchObject({
          kind: "open-tui",
          workspace: "/tmp/hatch-work",
          agentDraft: "hatch",
        });
        expect(reply.text).toContain("Your agent is hatching");
        expect(reply.text).toContain("You can return through Settings → Ask OpenClaw.");
      } else {
        expect(reply.action).toBe("none");
        expect(reply.agentDraft).toBeUndefined();
        expect(reply.handoff).toBeUndefined();
        expect(reply.text).not.toContain("Your agent is hatching");
      }
    },
  );

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
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => {
      if (runAgentTurn.mock.calls.length === 1) {
        params.session.proposalRef.current = "registered-operation";
        return { text: "I can change that after your approval." };
      }
      observedProposalOnSecondTurn = params.session.proposalRef.current;
      return { text: "Okay, leaving it as is." };
    });
    const engine = createEngine({
      runAgentTurn,
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
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => {
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
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (_params) => ({
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
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => {
      observedInputs.push(params.input);
      return observedInputs.length === 1 ? null : { text: "native reply" };
    });
    const engine = createEngine({
      runAgentTurn,
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
      const engine = createChatEngine({
        runAgentTurn,
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
    const engine = createChatEngine({
      classifyApproval: async () => "other",
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "still pending" };
      },
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
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({ text: "should never run" }));
    const engine = createChatEngine({
      runAgentTurn,
    });

    const reply = await engine.handle('config schema gateway.auth["token=abcDEF123"]');

    expect(reply.text).toContain("Invalid config path");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(engine.historySince(0))).not.toContain("abcDEF123");
  });

  it("redacts vulnerable config command text when persisted history is seeded", () => {
    const engine = createChatEngine({});

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
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({ text: "should never run" }));
    const engine = createChatEngine({
      runAgentTurn,
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
      const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async () => ({ text: "noted" }));
      const engine = createChatEngine({
        runAgentTurn,
        classifyApproval: async () => "other",
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
