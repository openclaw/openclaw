import { beforeEach, expect, it, vi } from "vitest";
import { handleAbortTrigger } from "./commands-session-abort.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const { persistAbortTargetEntryMock, setAbortMemoryMock, abortSessionRunTargetWithOutcomeMock } =
  vi.hoisted(() => ({
    persistAbortTargetEntryMock: vi.fn(),
    setAbortMemoryMock: vi.fn(),
    abortSessionRunTargetWithOutcomeMock: vi.fn(),
  }));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("./abort-operation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./abort-operation.js")>()),
  captureChannelSessionStop: vi.fn((params: { key?: string; sessionId?: string }) => params),
  abortSessionRunTargetWithOutcome: abortSessionRunTargetWithOutcomeMock,
  stopSubagentsForRequester: vi.fn(async () => ({ stopped: 0, failed: 0 })),
}));

vi.mock("./abort-primitives.js", () => ({
  setAbortMemory: setAbortMemoryMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
  resolveCommandSessionEntryForKey: vi.fn(() => ({ entry: undefined, key: "agent:main:main" })),
}));

function buildAbortParams(authorized: boolean) {
  const sessionEntry = { sessionId: "session-1", updatedAt: Date.now(), abortedLastRun: false };
  const params = buildPluginsCommandParams({
    commandBodyNormalized: "stop",
    cfg: {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    },
  });
  Object.assign(params.command, {
    isAuthorizedSender: authorized,
    senderIsOwner: authorized,
    senderId: "unauthorized",
  });
  return Object.assign(params, {
    sessionKey: "agent:main:main",
    sessionEntry,
    sessionStore: { "agent:main:main": { ...sessionEntry } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  abortSessionRunTargetWithOutcomeMock.mockImplementation((params) => {
    return {
      completed: (async () => {
        await params.stopChildren?.(async () => true);
        return { alreadyFinalizing: true, childrenStopped: 0, childFailures: 0 };
      })(),
    };
  });
});

it.each([false, true])(
  "handles authorized=%s aborts without persisting state",
  async (authorized) => {
    const result = await handleAbortTrigger(buildAbortParams(authorized), true);
    expect(result).toEqual(
      authorized
        ? {
            shouldContinue: false,
            reply: { text: "Agent reply is already finalizing and can no longer be aborted." },
          }
        : { shouldContinue: false },
    );
    if (authorized) {
      expect(abortSessionRunTargetWithOutcomeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          hookContext: expect.objectContaining({
            sessionKey: "agent:main:main",
            commandSource: "whatsapp",
            senderId: "unauthorized",
          }),
        }),
      );
    } else {
      expect(abortSessionRunTargetWithOutcomeMock).not.toHaveBeenCalled();
    }
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
  },
);
