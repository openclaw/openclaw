import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { buildOnboardingWelcome } from "./onboarding-welcome.js";

const mocks = vi.hoisted(() => {
  const sourceConfig: Pick<OpenClawConfig, "agents" | "wizard" | "gateway"> = {};
  return {
    readLocalOnboardingState: vi.fn<
      (
        configPath: string,
        config: { wizard?: { securityAcknowledgedAt?: string } },
      ) => LocalOnboardingState | undefined
    >(() => undefined),
    sourceConfig,
  };
});

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({ sourceConfig: mocks.sourceConfig })),
}));

vi.mock("../state/local-onboarding-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/local-onboarding-state.js")>()),
  readLocalOnboardingStateForConfigAsync: mocks.readLocalOnboardingState,
}));

vi.mock("../commands/onboard-helpers.js", () => ({ DEFAULT_WORKSPACE: "/default/workspace" }));

function createWelcomeEngine(
  defaultModel: string | undefined,
  config: { exists: boolean; valid: boolean } = {
    exists: true,
    valid: true,
  },
  gateway?: { reachable: boolean; url: string },
) {
  return {
    loadOverview: vi.fn(async () => ({
      config: { path: "/tmp/openclaw.json", ...config },
      defaultModel,
      ...(gateway ? { gateway } : {}),
    })),
    propose: vi.fn(),
    noteAssistantMessage: vi.fn(),
  };
}

function welcome(
  engine: ReturnType<typeof createWelcomeEngine>,
  options: Omit<Parameters<typeof buildOnboardingWelcome>[0], "engine"> = {},
) {
  return buildOnboardingWelcome({ engine: engine as never, ...options });
}

const acknowledgedAt = "2026-07-13T00:00:00.000Z";
function acknowledge(securityAcknowledgedAt = acknowledgedAt) {
  mocks.sourceConfig.wizard = { securityAcknowledgedAt };
}

function receipt(overrides: Partial<LocalOnboardingState> = {}): LocalOnboardingState {
  return {
    version: 1,
    status: "pending",
    runId: "pending-onboarding",
    configPath: "/tmp/openclaw.json",
    workspace: "/recovered/workspace",
    securityAcknowledgedAt: acknowledgedAt,
    startedAtMs: 1,
    ...overrides,
  };
}

function readyEngine(url = "ws://127.0.0.1:18789") {
  return createWelcomeEngine("openai/gpt-5.6-luna", undefined, { reachable: true, url });
}

function expectReceiptRead() {
  expect(mocks.readLocalOnboardingState).toHaveBeenCalledWith(
    "/tmp/openclaw.json",
    mocks.sourceConfig,
  );
}

async function expectReady(engine: ReturnType<typeof createWelcomeEngine>, localRecovery?: true) {
  const { question } = await welcome(engine, { localRecovery });
  expect(engine.propose).not.toHaveBeenCalled();
  expect(question.id).toBe("onboarding-next-step");
}

describe("buildOnboardingWelcome", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    mocks.sourceConfig.agents = { defaults: { workspace: "/existing/workspace" } };
    mocks.sourceConfig.wizard = undefined;
    mocks.sourceConfig.gateway = undefined;
    mocks.readLocalOnboardingState.mockReset().mockReturnValue(undefined);
  });

  it.each([
    ["zh-CN", "你好，我是 OpenClaw", "是的 — 开始设置", "推理已就绪", "和我的智能体聊天"],
    ["zh-TW", "你好，我是 OpenClaw", "是的 — 開始設定", "推理已就緒", "與我的智慧代理聊天"],
  ] as const)(
    "localizes setup and ready welcomes in %s without translating command replies",
    async (locale, intro, setupLabel, readyTitle, readyLabel) => {
      vi.stubEnv("OPENCLAW_LOCALE", "en");
      const engine = createWelcomeEngine("example/verified-model", undefined, {
        reachable: true,
        url: "ws://127.0.0.1:19431",
      });
      const setup = await welcome(engine, { locale });
      expect(setup.text).toContain(intro);
      expect(setup.text).toContain("example/verified-model");
      expect(setup.text).toContain("/existing/workspace");
      expect(setup.question.options[0]).toMatchObject({ label: setupLabel, reply: "yes" });

      acknowledge("2026-09-30T00:00:00.000Z");
      const ready = await welcome(engine, { locale });
      expect(ready.text).toContain(readyTitle);
      expect(ready.text).toContain("ws://127.0.0.1:19431");
      expect(ready.question.options[0]).toMatchObject({
        label: readyLabel,
        reply: "talk to agent",
      });
      expect(ready.question.skipAction).toBe("exit");
    },
  );

  it("preserves an authored workspace in a partial setup", async () => {
    const engine = createWelcomeEngine("openai/gpt-5.5");
    const { text, question } = await welcome(engine, { agentName: "robby" });

    expect(engine.propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/existing/workspace",
      agentName: "robby",
    });
    expect(question.id).toBe("onboarding-apply-setup");
    expect(question.options[0]).toMatchObject({
      label: "Yes — set it up",
      reply: "yes",
      recommended: true,
    });
    expect(text).toContain("Workspace: /existing/workspace");
    expect(text).toContain("AI: openai/gpt-5.5 — already verified with a real reply");
  });

  it("resumes pending local onboarding in the receipt's authoritative workspace", async () => {
    mocks.sourceConfig.wizard = {
      securityAcknowledgedAt: acknowledgedAt,
      accessMode: "guarded",
    };
    mocks.sourceConfig.gateway = { auth: { mode: "token", token: "existing-token" } };
    mocks.readLocalOnboardingState.mockReturnValueOnce(receipt());
    const engine = createWelcomeEngine("openai/gpt-5.6-luna", { exists: true, valid: true });
    const { text, question } = await welcome(engine, {
      workspace: "/requested/workspace",
      localRecovery: true,
    });

    expectReceiptRead();
    expect(engine.propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/recovered/workspace",
    });
    expect(question.id).toBe("onboarding-apply-setup");
    expect(text).toContain("Workspace: /recovered/workspace");
  });

  it("keeps the ready welcome after a local onboarding receipt completes", async () => {
    acknowledge();
    mocks.readLocalOnboardingState.mockReturnValueOnce(
      receipt({ status: "completed", completedAtMs: 2 }),
    );
    await expectReady(readyEngine(), true);
    expectReceiptRead();
  });

  it("ignores a pending receipt from a replaced configuration", async () => {
    acknowledge("2026-08-03T00:00:00.000Z");
    mocks.readLocalOnboardingState.mockImplementation((_configPath, config) =>
      config.wizard?.securityAcknowledgedAt === "2026-08-02T00:00:00.000Z"
        ? receipt({
            workspace: "/replaced/workspace",
            securityAcknowledgedAt: "2026-08-02T00:00:00.000Z",
          })
        : undefined,
    );
    await expectReady(readyEngine(), true);
    expectReceiptRead();
  });

  it("never applies machine-local recovery to Gateway onboarding", async () => {
    acknowledge();
    mocks.readLocalOnboardingState.mockReturnValueOnce(receipt());
    await expectReady(readyEngine());
    expect(mocks.readLocalOnboardingState).not.toHaveBeenCalled();
  });

  it("never reads a local onboarding receipt for a remote Gateway", async () => {
    acknowledge();
    mocks.sourceConfig.gateway = { mode: "remote" };
    await expectReady(readyEngine("wss://gateway.example.test"), true);
    expect(mocks.readLocalOnboardingState).not.toHaveBeenCalled();
  });

  it("advertises only the route that passed the inference gate", async () => {
    const engine = createWelcomeEngine("openai/gpt-5.5", { exists: false, valid: false });
    const { text } = await welcome(engine, { localRecovery: true });

    expect(mocks.readLocalOnboardingState).not.toHaveBeenCalled();
    expect(text).toContain("AI: openai/gpt-5.5 — already verified with a real reply");
    expect(text).not.toContain("Claude Code");
    expect(text).not.toContain("Codex login");
  });

  it("ignores a blank authored workspace", async () => {
    mocks.sourceConfig.agents = {
      ...mocks.sourceConfig.agents,
      defaults: { ...mocks.sourceConfig.agents?.defaults, workspace: "   " },
    };
    const engine = createWelcomeEngine("openai/gpt-5.5");
    const { propose } = engine;

    await buildOnboardingWelcome({ engine: engine as never });

    expect(propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/default/workspace",
    });
  });

  it("honors an explicit workspace override on an authored setup", async () => {
    mocks.sourceConfig.gateway = { auth: { mode: "token", token: "existing-token" } };
    const engine = createWelcomeEngine("openai/gpt-5.5");
    const { text } = await welcome(engine, { workspace: "/requested/workspace" });

    expect(engine.propose).toHaveBeenCalledWith({
      kind: "setup",
      workspace: "/requested/workspace",
    });
    expect(text).toContain("Workspace: /requested/workspace");
  });

  it("fails closed before proposing setup when inference is missing", async () => {
    const engine = createWelcomeEngine(undefined);
    await expect(welcome(engine)).rejects.toThrow("requires working inference first");

    expect(engine.propose).not.toHaveBeenCalled();
    expect(engine.noteAssistantMessage).not.toHaveBeenCalled();
  });

  it.each([
    { label: "blank token", auth: { token: "   " }, configured: false },
    {
      label: "SecretRef token",
      auth: { token: { source: "env" as const, provider: "default", id: "GATEWAY_TOKEN" } },
      configured: true,
    },
  ])("treats $label consistently with the app gate", async ({ auth, configured }) => {
    mocks.sourceConfig.gateway = { auth };
    const engine = createWelcomeEngine("openai/gpt-5.5", undefined, {
      reachable: true,
      url: "ws://127.0.0.1:18789",
    });
    const { text, question } = await welcome(engine);

    expect(engine.propose).toHaveBeenCalledTimes(configured ? 0 : 1);
    expect(question.id).toBe(configured ? "onboarding-next-step" : "onboarding-apply-setup");
    expect(question.skipAction).toBe(configured ? "exit" : undefined);
    expect(text.includes("Say **yes**")).toBe(!configured);
  });
});
