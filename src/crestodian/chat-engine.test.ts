// Chat engine tests: proposals, approvals, and the chat-hosted channel wizard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runCrestodianAgentTurnWithDeps } from "./agent-turn.js";
import { classifyCrestodianApprovalText } from "./approval-intent.js";
import { CrestodianChatEngine } from "./chat-engine.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
  readSetupConfigFileSnapshot: vi.fn(),
  setupChannels: vi.fn(),
  writeWizardConfigFile: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: mocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: mocks.writeWizardConfigFile,
}));

vi.mock("../commands/onboard-channels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-channels.js")>()),
  setupChannels: mocks.setupChannels,
}));

const tempDirs: string[] = [];

function useTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-engine-"));
  tempDirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.readConfigFileSnapshot.mockResolvedValue({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  } as never);
  mocks.readSetupConfigFileSnapshot.mockReset();
  mocks.setupChannels.mockReset();
  mocks.writeWizardConfigFile.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CrestodianChatEngine", () => {
  it("applies a seeded proposal on a bare yes", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({ deps: { runConfigSet } });

    const plan = engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });
    expect(plan).toContain("gateway.port");
    expect(engine.hasPendingProposal()).toBe(true);

    const reply = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.text).toContain("[crestodian] done: config.set");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("rejects setup before a default inference route exists", async () => {
    useTempStateDir();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      lines: ["Workspace: /tmp/work"],
    }));
    const engine = new CrestodianChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        applySetup,
        loadOverview: fakeOverviewLoader(),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/work" });

    const setup = await engine.handle("yes");

    expect(setup.text).toContain("requires working inference first");
    expect(setup.text).toContain("openclaw onboard");
    expect(engine.hasPendingProposal()).toBe(false);
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("routes model provider changes out of the active inference session", async () => {
    const engine = new CrestodianChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("configure model provider workspace /tmp/gateway-work");

    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.sensitive).toBeUndefined();
    expect(reply.text).toContain("replace the inference route powering this session");
    expect(reply.text).toContain("Exit Crestodian and run `openclaw onboard`");
  });

  it("keeps the current inference route when model provider setup is declined", async () => {
    const engine = new CrestodianChatEngine();
    engine.propose({ kind: "model-setup" });

    const reply = await engine.handle("not now");

    expect(reply.text).toContain("current inference route is unchanged");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("no thanks");
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(reply.text).toContain("Skipped");
    expect(engine.hasPendingProposal()).toBe(false);
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
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifyCrestodianApprovalText(message),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("change the model");
    const declined = await engine.handle("no thanks");

    // The decline voids the registered hash before the AI turn, so a later
    // generic approval can never arm the stale mutation.
    expect(observedProposalOnSecondTurn).toBeUndefined();
    expect(declined.text).toContain("leaving it as is");
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("hosts a channel setup wizard as chat turns", async () => {
    useTempStateDir();
    const wizardRuns: string[] = [];
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (channel: string, prompter: WizardPrompter) => {
        wizardRuns.push(channel);
        const token = await prompter.text({ message: "Bot token" });
        wizardRuns.push(`token:${token}`);
        const mode = await prompter.select({
          message: "DM mode",
          options: [
            { value: "pair", label: "Pairing" },
            { value: "open", label: "Open" },
          ],
        });
        wizardRuns.push(`mode:${mode}`);
      },
    });

    // Starting the wizard is not a write: it begins immediately, no approval step.
    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");

    const modeStep = await engine.handle("123:abc");
    expect(modeStep.text).toContain("1. Pairing");

    const done = await engine.handle("2");
    expect(done.text).toContain("telegram is configured");
    expect(wizardRuns).toEqual(["telegram", "token:123:abc", "mode:open"]);
  });

  it("rejects a hosted channel commit after a concurrent inference-route change", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: {
        profiles: { "openai:main": { provider: "openai", mode: "api_key" } },
      },
    };
    let currentConfig = structuredClone(baseConfig);
    let currentHash = "base-hash";
    mocks.readSetupConfigFileSnapshot.mockImplementation(async () => ({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: currentHash,
      config: structuredClone(currentConfig),
      sourceConfig: structuredClone(currentConfig),
      issues: [],
    }));
    mocks.setupChannels.mockImplementation(
      async (config: OpenClawConfig, _runtime: unknown, prompter: WizardPrompter) => {
        const token = await prompter.text({ message: "Bot token" });
        return {
          ...config,
          channels: {
            ...config.channels,
            telegram: { botToken: token },
          },
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(
      async (nextConfig: OpenClawConfig, opts: { baseHash?: string }) => {
        if (opts.baseHash !== currentHash) {
          throw new Error("configuration changed during channel setup");
        }
        currentConfig = structuredClone(nextConfig);
        currentHash = "committed-hash";
        return nextConfig;
      },
    );
    const engine = new CrestodianChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");

    const concurrentConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
      auth: {
        profiles: { "anthropic:main": { provider: "anthropic", mode: "api_key" } },
      },
    };
    currentConfig = structuredClone(concurrentConfig);
    currentHash = "concurrent-hash";

    const stopped = await engine.handle("123:abc");

    expect(stopped.text).toContain("Channel setup stopped");
    expect(stopped.text).toContain("configuration changed during channel setup");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({ telegram: { botToken: "123:abc" } }),
      }),
      expect.objectContaining({
        baseHash: "base-hash",
        migrationBaseConfig: baseConfig,
      }),
    );
    expect(currentConfig).toEqual(concurrentConfig);
  });

  it("marks sensitive hosted-wizard replies and auto-advances notes", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.note("Before entering the token, open the provider console.");
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const tokenStep = await engine.handle("connect telegram");

    expect(tokenStep.text).toContain("Before entering the token");
    expect(tokenStep.text).toContain("Bot token");
    expect(tokenStep.sensitive).toBe(true);
  });

  it("routes sensitive CLI wizard prompts to the masked channel setup flow", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const reply = await engine.handle("connect telegram");

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

  it("routes inference setup out of both CLI and gateway sessions", async () => {
    const common = {
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    };
    const cli = new CrestodianChatEngine({ ...common, surface: "cli" });
    for (const command of ["open setup wizard", "open classic wizard"]) {
      const cliReply = await cli.handle(command);
      expect(cliReply.action).toBe("none");
      expect(cliReply.handoff).toBeUndefined();
      expect(cliReply.text).toContain("run `openclaw onboard`");
    }

    const gateway = new CrestodianChatEngine({ ...common, surface: "gateway" });
    const gatewayReply = await gateway.handle("open setup wizard");
    expect(gatewayReply.action).toBe("none");
    expect(gatewayReply.handoff).toBeUndefined();
    expect(gatewayReply.text).toContain("The app owns the setup screens here");
  });

  it.each([
    { command: "open setup wizard", action: "none" },
    { command: "configure model provider", action: "none" },
  ] as const)(
    "voids stale agent proposals before the exact $command route",
    async ({ command, action }) => {
      const armed: boolean[] = [];
      const runAgentTurn = vi.fn(
        async (params: {
          approvalArmed: boolean;
          session: { proposalRef: { current?: string } };
        }) => {
          armed.push(params.approvalArmed);
          if (armed.length === 1) {
            params.session.proposalRef.current = "stale-operation";
          }
          return { text: "No pending change." };
        },
      );
      const engine = new CrestodianChatEngine({
        surface: "cli",
        runAgentTurn: runAgentTurn as never,
        classifyApproval: async ({ message }) => classifyCrestodianApprovalText(message),
        deps: { loadOverview: fakeOverviewLoader() },
      });

      await engine.handle("prepare a change for me");
      const handoff = await engine.handle(command);
      await engine.handle("yes");

      expect(handoff.action).toBe(action);
      expect(armed).toEqual([false, false]);
    },
  );

  it("keeps hosted-wizard validation errors on the current prompt", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({
          message: "Port",
          validate: (value) => (value === "18789" ? undefined : "Enter port 18789"),
        });
      },
    });

    const prompt = await engine.handle("connect telegram");
    expect(prompt.text).toContain("Port");
    const invalid = await engine.handle("banana");
    expect(invalid.text).toContain("Enter port 18789");
    expect(invalid.text).toContain("Port");
    const done = await engine.handle("18789");
    expect(done.text).toContain("telegram is configured");
  });

  it("cancels a hosted wizard mid-flight", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const tokenStep = await engine.handle("connect discord");
    expect(tokenStep.text).toContain("Bot token");

    const cancelled = await engine.handle("cancel");
    expect(cancelled.text).toContain("cancelled");
  });

  it("voids a stale host proposal before an exact wizard, including cancellation", async () => {
    const runConfigSet = vi.fn(async () => {});
    const runAgentTurn = vi.fn(async (params: { approvalArmed: boolean }) => ({
      text: params.approvalArmed ? "unexpected approval" : "No pending change.",
    }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifyCrestodianApprovalText(message),
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("connect discord");
    const cancelled = await engine.handle("cancel");
    const laterApproval = await engine.handle("yes");

    expect(cancelled.text).toContain("cancelled");
    expect(engine.hasPendingProposal()).toBe(false);
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(runAgentTurn.mock.calls.at(-1)?.[0]?.approvalArmed).toBe(false);
    expect(laterApproval.text).toContain("No pending change");
  });

  it("voids a stale agent proposal after an exact wizard completes", async () => {
    useTempStateDir();
    const armed: boolean[] = [];
    const runAgentTurn = vi.fn(
      async (params: {
        approvalArmed: boolean;
        session: { proposalRef: { current?: string } };
      }) => {
        armed.push(params.approvalArmed);
        if (armed.length === 1) {
          params.session.proposalRef.current = "stale-operation";
        }
        return { text: "No pending change." };
      },
    );
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifyCrestodianApprovalText(message),
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("prepare a change for me");
    await engine.handle("connect telegram");
    const done = await engine.handle("123:abc");
    await engine.handle("yes");

    expect(done.text).toContain("telegram is configured");
    expect(armed).toEqual([false, false]);
  });

  it("signals the exact agent handoff without an inference turn", async () => {
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("talk to agent");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff?.kind).toBe("open-tui");
  });

  it("handles the exact agent handoff without consulting a usable model", async () => {
    const runAgentTurn = vi.fn(async () => ({ text: "model reply without a directive" }));
    const engine = new CrestodianChatEngine({
      runAgentTurn,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("talk to agent");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toEqual({ kind: "open-tui" });
  });

  it("executes an open-tui directive from the agent loop", async () => {
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => ({
        text: "Handing you over. *waves claw*",
        directive: { kind: "open-tui" as const, agentId: "work" },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("I want to talk to my work agent now");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toMatchObject({ kind: "open-tui", agentId: "work" });
    expect(reply.text).toContain("Handing you over");
  });

  it("does not replay a failed host directive through the planner", async () => {
    const planner = vi.fn(async () => ({ reply: "should not run" }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => ({
        text: "Opening setup.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      planWithAssistant: planner,
      runChannelSetupWizard: async () => {
        throw new Error("wizard exploded");
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect telegram for me");

    expect(reply.text).toContain("wizard exploded");
    expect(planner).not.toHaveBeenCalled();
  });

  it("routes an inference-setup directive out of the agent loop", async () => {
    const engine = new CrestodianChatEngine({
      surface: "cli",
      runAgentTurn: async () => ({
        text: "Opening the menu wizard.",
        directive: { kind: "open-setup" as const, target: "guided" as const },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("I would rather use menus");
    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).toContain("Opening the menu wizard");
    expect(reply.text).toContain("run `openclaw onboard`");
  });

  it("starts the channel wizard from an agent-loop directive", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => ({
        text: "Telegram it is — setup questions follow.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });
    const reply = await engine.handle("hook me up with telegram please");
    expect(reply.text).toContain("Telegram it is");
    expect(reply.text).toContain("Bot token");
  });

  it("arms an agent turn when the classifier approves in the user's own words", async () => {
    const armedFlags: boolean[] = [];
    const runAgentTurn = vi.fn(
      async (params: {
        approvalArmed: boolean;
        session: { proposalRef: { current?: string } };
      }) => {
        armedFlags.push(params.approvalArmed);
        params.session.proposalRef.current = "op-hash";
        return { text: "ok" };
      },
    );
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) =>
        message.includes("sounds great") ? "approve" : "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("switch me to gpt");
    await engine.handle("that sounds great, please");

    expect(armedFlags).toEqual([false, true]);
  });

  it("clears a stale host proposal once the agent loop owns the conversation", async () => {
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => ({ text: "loop reply" }),
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("actually, tell me about workspaces first");

    // A later approval must arm the loop's own proposal, not the stale one.
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("keeps an exact sensitive config set away from every model path", async () => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const planner = vi.fn(async () => ({ reply: "should never run" }));
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      planWithAssistant: planner as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle("config set channels.telegram.botToken 123:very-secret");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(planner).not.toHaveBeenCalled();
    expect(proposed.text).toContain("<redacted>");
    expect(proposed.text).not.toContain("very-secret");
    expect(engine.hasPendingProposal()).toBe(true);

    const applied = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(applied.text).toContain("[crestodian] done: config.set");
  });

  it("redacts sensitive config-set values from the AI-visible history", async () => {
    const planner = vi.fn(async (_params: { history?: Array<{ role: string; text: string }> }) => ({
      reply: "noted",
    }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("config set channels.telegram.botToken 123:very-secret");
    await engine.handle("did that work?");

    const history = planner.mock.calls.at(-1)?.[0]?.history ?? [];
    const userTurns = history.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns.some((text) => text.includes("very-secret"))).toBe(false);
    expect(userTurns.some((text) => text.includes("<redacted secret>"))).toBe(true);
  });

  it("prefers the real agent loop for fuzzy messages", async () => {
    const runAgentTurn = vi.fn(
      async (_params: {
        input: string;
        surface: string;
        approvalArmed: boolean;
        session: { sessionId: string };
      }) => ({
        text: "*click* I checked your shell — all good. Want channels next?",
        modelLabel: "openai/gpt-5.5",
      }),
    );
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn,
      planWithAssistant: planner,
      surface: "gateway",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("how is my setup looking?");

    expect(reply.text).toContain("I checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = runAgentTurn.mock.calls[0][0];
    expect(call.input).toContain("setup looking");
    expect(call.surface).toBe("gateway");
    // A question is not consent: mutations stay locked for this turn.
    expect(call.approvalArmed).toBe(false);
    expect(call.session.sessionId).toMatch(/^crestodian-/);
    // The same session flows into every turn for real multi-turn memory.
    await engine.handle("and the gateway?");
    expect(runAgentTurn.mock.calls[1]?.[0]).toMatchObject({
      session: { sessionId: call.session.sessionId },
    });
  });

  it("answers fuzzy messages through the AI custodian with conversation history", async () => {
    const planner = vi.fn(
      async (_params: { input: string; history?: Array<{ role: string; text: string }> }) => ({
        reply: "I'm your setup custodian. Nothing changes without your yes.",
      }),
    );
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.noteAssistantMessage("welcome text");

    const reply = await engine.handle("what are you going to do to my machine?");

    expect(reply.text).toContain("setup custodian");
    expect(reply.action).toBe("none");
    const call = planner.mock.calls[0][0];
    expect(call.input).toContain("machine");
    expect(call.history?.[0]).toEqual({ role: "assistant", text: "welcome text" });
  });

  it("routes AI-proposed persistent commands through approval with provenance", async () => {
    const planner = vi.fn(async () => ({
      reply: "Let's point your agent at gpt-5.5.",
      command: "set default model openai/gpt-5.5",
      modelLabel: "claude-cli",
    }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("actually use an openai model");

    expect(reply.text).toContain("Let's point your agent at gpt-5.5.");
    expect(reply.text).toContain("(claude-cli → `set default model openai/gpt-5.5`)");
    expect(reply.text).toContain("Apply this operation");
    expect(engine.hasPendingProposal()).toBe(true);
  });

  it("keeps a pending proposal when the user asks a question instead of yes/no", async () => {
    const planner = vi.fn(async (_params: { input: string; pendingOperation?: string }) => ({
      reply: "A workspace is where your agent keeps its files.",
    }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("wait, what's a workspace?");

    expect(reply.text).toContain("agent keeps its files");
    expect(engine.hasPendingProposal()).toBe(true);
    const call = planner.mock.calls[0][0];
    expect(call.pendingOperation).toContain("gateway.port");
  });

  it("verifies config after an applied write and drives a self-fix turn", async () => {
    useTempStateDir();
    const planner = vi.fn(async (params: { input: string }) => {
      if (params.input.startsWith("[config-verify]")) {
        return {
          reply: "That port was not a number — here is the fix.",
          command: "config set gateway.port 18789",
          modelLabel: "claude-cli",
        };
      }
      return null;
    });
    // The write flips the config to invalid: every snapshot read after the
    // stubbed set reports validation issues (audit reads happen before/after).
    const runInvalidConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        path: "/tmp/openclaw.json",
        hash: "h",
        config: {},
        sourceConfig: {},
        issues: [{ path: "gateway.port", message: "Expected number, received string" }],
      } as never);
    });
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      deps: { runConfigSet: runInvalidConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "banana" });

    const reply = await engine.handle("yes");

    expect(reply.text).toContain("failed validation");
    expect(reply.text).toContain("gateway.port: Expected number, received string");
    expect(reply.text).toContain("That port was not a number");
    expect(reply.text).toContain("config set gateway.port 18789");
    // The corrective write is proposed, not auto-applied.
    expect(engine.hasPendingProposal()).toBe(true);
    expect(planner.mock.calls[0]?.[0]?.input).toContain("[config-verify]");
  });

  it("reports an applied invalid write when inference cannot propose a repair", async () => {
    useTempStateDir();
    const runInvalidConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        path: "/tmp/openclaw.json",
        hash: "h",
        config: {},
        sourceConfig: {},
        issues: [{ path: "gateway.port", message: "Expected number, received string" }],
      } as never);
    });
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => {
        throw new CrestodianInferenceUnavailableError("agent-turn");
      },
      planWithAssistant: async () => null,
      deps: { runConfigSet: runInvalidConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "banana" });

    const reply = await engine.handle("yes");

    expect(runInvalidConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("failed validation");
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("warns when an applied write leaves no config to verify", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: false,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: null,
        config: {},
        sourceConfig: {},
        issues: [],
      } as never);
    });
    const engine = new CrestodianChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("post-write verification is unavailable");
    expect(reply.text).toContain("openclaw.json was not found");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("warns when the applied write cannot be read back for verification", async () => {
    useTempStateDir();
    const validSnapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      issues: [],
    } as never;
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce(validSnapshot)
      .mockResolvedValueOnce(validSnapshot)
      .mockRejectedValueOnce(new Error("snapshot read failed"));
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("post-write verification is unavailable");
    expect(reply.text).toContain("openclaw.json could not be read");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("stays quiet when the post-write validation passes", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(reply.text).not.toContain("failed validation");
    expect(planner).not.toHaveBeenCalled();
  });

  it("fails closed when neither inference path is usable", async () => {
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await expect(engine.handle("please make everything nice")).rejects.toBeInstanceOf(
      CrestodianInferenceUnavailableError,
    );
  });
});

describe("Crestodian agent loop backends", () => {
  it("runs a configured claude-cli model through the CLI loop with the ring-zero MCP tool", async () => {
    useTempStateDir();
    const snapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      runtimeConfig: {
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-opus-4-8" },
            cliBackends: { "claude-cli": {} },
          },
        },
      },
      issues: [],
    };
    const runCliAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      payloads: [{ text: "*click* CLI loop checked your shell." }],
      meta: { agentMeta: { cliSessionBinding: { sessionId: "native-1" } } },
    }));
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn: (params) =>
        runCrestodianAgentTurnWithDeps(params, {
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: (async () => snapshot) as never,
        }),
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader({ defaultModel: "claude-cli/claude-opus-4-8" }) },
    });

    const reply = await engine.handle("how is my setup looking?");

    expect(reply.text).toContain("CLI loop checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = runCliAgent.mock.calls[0][0];
    expect(call.provider).toBe("claude-cli");
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.crestodianTool).toEqual({
      surface: "cli",
      approvalArmed: false,
      proposalRef: {},
      directiveRef: {},
    });
    // CLI harnesses reject toolsAllow; the restriction rides on the MCP config.
    expect(call.toolsAllow).toBeUndefined();
    expect(call.cliSessionBinding).toBeUndefined();
    expect(call.cleanupCliLiveSessionOnRunEnd).toBe(true);

    // The captured native CLI session resumes on the next turn.
    await engine.handle("and the gateway?");
    expect(runCliAgent.mock.calls[1][0].cliSessionBinding).toEqual({ sessionId: "native-1" });
  });

  it("falls back to the single-turn planner when the CLI loop fails", async () => {
    useTempStateDir();
    const snapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      runtimeConfig: {
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-opus-4-8" },
            cliBackends: { "claude-cli": {} },
          },
        },
      },
      issues: [],
    };
    const runCliAgent = vi.fn(async () => {
      throw new Error("claude exploded");
    });
    const planner = vi.fn(async () => ({ reply: "planner fallback reply" }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: (params) =>
        runCrestodianAgentTurnWithDeps(params, {
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: (async () => snapshot) as never,
        }),
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader({ defaultModel: "claude-cli/claude-opus-4-8" }) },
    });

    const reply = await engine.handle("do a health check");

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(reply.text).toContain("planner fallback reply");
  });
});

function fakeOverviewLoader(
  overrides: { defaultModel?: string; claudeFound?: boolean; codexFound?: boolean } = {},
) {
  return async () =>
    ({
      config: { path: "/tmp/openclaw.json", exists: false, valid: true, issues: [], hash: null },
      agents: [],
      defaultAgentId: "main",
      defaultModel: overrides.defaultModel,
      tools: {
        codex: { command: "codex", found: overrides.codexFound ?? false },
        claude: { command: "claude", found: overrides.claudeFound ?? false },
        gemini: { command: "gemini", found: false },
        apiKeys: { openai: false, anthropic: false },
      },
      gateway: { url: "ws://127.0.0.1:18789", source: "local", reachable: false },
      references: {
        docsUrl: "https://docs.openclaw.ai",
        sourceUrl: "https://github.com/openclaw/openclaw",
      },
    }) as never;
}
