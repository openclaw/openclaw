import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  closeAdmission: vi.fn(),
  prepareInternalSession: vi.fn(),
  removeInternalSession: vi.fn(),
  runEmbeddedAgent: vi.fn(),
}));

vi.mock("../agents/admitted-run-context.js", () => ({
  prepareSystemAgentRunAdmission: () => ({ close: mocks.closeAdmission }),
}));
vi.mock("../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent: () => ({
    modelId: "test-model",
    provider: "test-provider",
  }),
}));
vi.mock("../config/sessions.js", () => ({
  resolveSessionStorePathCore: () => "/tmp/session-companion-default-run-test.sqlite",
}));
vi.mock("../agents/internal-session-effects.js", () => ({
  prepareInternalSessionEffectsSession: mocks.prepareInternalSession,
  removeInternalSessionEffectsSession: mocks.removeInternalSession,
}));
vi.mock("../agents/sessions/index.js", () => ({
  SessionManager: { open: () => ({ appendMessage: mocks.appendMessage }) },
}));
vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

import { SessionCompanionAskError } from "./session-companion-ask.js";
import { runSessionCompanionDefault } from "./session-companion-run.js";

const target = {
  agentId: "main",
  sessionEntry: { sessionId: "internal-session", updatedAt: 1 },
  sessionFile: "internal-session-file",
  sessionId: "internal-session",
  sessionKey: "agent:main:internal",
  storePath: "/tmp/session-companion-default-run-test.sqlite",
};

function run(authorize: () => boolean) {
  return runSessionCompanionDefault({
    cfg: {},
    agentId: "main",
    modelRef: "test-provider/test-model",
    sessionKey: "agent:main:owner-session",
    workspaceDir: "/tmp",
    systemPrompt: "Read-only Side chat.",
    messages: [
      { role: "assistant", content: "private reference", ts: 1 },
      { role: "user", content: "What happened?", ts: 2 },
    ],
    authorize,
    signal: new AbortController().signal,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.prepareInternalSession.mockResolvedValue(target);
  mocks.runEmbeddedAgent.mockResolvedValue({
    meta: { finalAssistantVisibleText: "Authorized answer." },
    payloads: [],
  });
});

describe("session companion production runner authorization", () => {
  it("runs and cleans up the internal effects session while access remains authorized", async () => {
    mocks.prepareInternalSession.mockResolvedValue(target);
    mocks.runEmbeddedAgent.mockResolvedValue({
      meta: { finalAssistantVisibleText: "Authorized answer." },
      payloads: [],
    });

    await expect(run(() => true)).resolves.toBe("Authorized answer.");

    expect(mocks.appendMessage).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(mocks.removeInternalSession).toHaveBeenCalledWith(target);
    expect(mocks.closeAdmission).toHaveBeenCalledOnce();
  });

  it("rejects revocation during internal-session preparation before persistence or model I/O", async () => {
    let authorized = true;
    mocks.prepareInternalSession.mockImplementation(async () => {
      authorized = false;
      return target;
    });

    await expect(run(() => authorized)).rejects.toMatchObject({
      reason: "session-missing",
      message: "Side chat is unavailable.",
    } satisfies Partial<SessionCompanionAskError>);

    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(mocks.removeInternalSession).toHaveBeenCalledWith(target);
  });

  it("rejects revocation at the embedded runner's provider boundary and removes temporary effects", async () => {
    let authorized = true;
    mocks.prepareInternalSession.mockResolvedValue(target);
    mocks.runEmbeddedAgent.mockImplementation(
      async (params: { assertRunAuthorization?: () => void }) => {
        authorized = false;
        params.assertRunAuthorization?.();
        return {
          meta: { finalAssistantVisibleText: "Must not be returned." },
          payloads: [],
        };
      },
    );

    await expect(run(() => authorized)).rejects.toMatchObject({
      reason: "session-missing",
      message: "Side chat is unavailable.",
    } satisfies Partial<SessionCompanionAskError>);

    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(mocks.removeInternalSession).toHaveBeenCalledWith(target);
    expect(mocks.closeAdmission).toHaveBeenCalledOnce();
  });
});
