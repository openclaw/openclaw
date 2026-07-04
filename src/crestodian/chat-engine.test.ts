// Chat engine tests: proposals, approvals, and the chat-hosted channel wizard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import { CrestodianChatEngine } from "./chat-engine.js";

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
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
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

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("no thanks");
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(reply.text).toContain("Skipped");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("hosts a channel setup wizard as chat turns after approval", async () => {
    useTempStateDir();
    const wizardRuns: string[] = [];
    const engine = new CrestodianChatEngine({
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

    const plan = await engine.handle("connect telegram");
    expect(plan.text).toContain("walk through connecting the telegram channel");

    const tokenStep = await engine.handle("yes");
    expect(tokenStep.text).toContain("Bot token");

    const modeStep = await engine.handle("123:abc");
    expect(modeStep.text).toContain("1. Pairing");

    const done = await engine.handle("2");
    expect(done.text).toContain("telegram is configured");
    expect(wizardRuns).toEqual(["telegram", "token:123:abc", "mode:open"]);
  });

  it("cancels a hosted wizard mid-flight", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      yes: true,
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const tokenStep = await engine.handle("connect discord");
    expect(tokenStep.text).toContain("Bot token");

    const cancelled = await engine.handle("cancel");
    expect(cancelled.text).toContain("cancelled");
  });

  it("signals the agent handoff for talk to agent", async () => {
    const engine = new CrestodianChatEngine({});
    const reply = await engine.handle("talk to agent");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff?.kind).toBe("open-tui");
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
    const call = runAgentTurn.mock.calls[0]![0];
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
    const call = planner.mock.calls[0]![0];
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
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("wait, what's a workspace?");

    expect(reply.text).toContain("agent keeps its files");
    expect(engine.hasPendingProposal()).toBe(true);
    const call = planner.mock.calls[0]![0];
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

  it("falls back to deterministic guidance when no model is usable", async () => {
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("please make everything nice");

    expect(reply.text).toContain("deterministic mode");
    expect(reply.text).toContain("connect telegram");
  });
});

function fakeOverviewLoader() {
  return async () =>
    ({
      config: { path: "/tmp/openclaw.json", exists: false, valid: true, issues: [], hash: null },
      agents: [],
      defaultAgentId: "main",
      defaultModel: undefined,
      tools: {
        codex: { command: "codex", found: false },
        claude: { command: "claude", found: false },
        apiKeys: { openai: false, anthropic: false },
      },
      gateway: { url: "ws://127.0.0.1:18789", source: "local", reachable: false },
      references: {
        docsUrl: "https://docs.openclaw.ai",
        sourceUrl: "https://github.com/openclaw/openclaw",
      },
    }) as never;
}
