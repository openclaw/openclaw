import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAbortTrigger } from "./commands-session-abort.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn());
const resolveCommandSessionEntryForKeyMock = vi.hoisted(() =>
  vi.fn(() => ({ entry: undefined, key: "agent:main:main" })),
);
const setAbortMemoryMock = vi.hoisted(() => vi.fn());
const abortSessionRunTargetWithOutcomeMock = vi.hoisted(() => vi.fn());

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("./abort-operation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./abort-operation.js")>()),
  captureChannelSessionStop: vi.fn((params: { key?: string; sessionId?: string }) => params),
  abortSessionRunTargetWithOutcome: abortSessionRunTargetWithOutcomeMock,
  stopSubagentsForRequester: vi.fn(async () => ({ stopped: 0, failed: 0 })),
}));

vi.mock("./abort-trigger-text.js", () => ({
  isAbortTrigger: vi.fn((raw: string) => raw === "stop"),
}));

vi.mock("./abort-primitives.js", () => ({
  setAbortMemory: setAbortMemoryMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
  resolveCommandSessionEntryForKey: resolveCommandSessionEntryForKeyMock,
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

describe("handleAbortTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abortSessionRunTargetWithOutcomeMock.mockImplementation((params) => {
      const outcome = {
        aborted: false,
        alreadyFinalizing: true,
        queuedCancelled: 0,
        activeCancelled: 0,
        childrenStopped: 0,
        childFailures: 0,
        failures: [],
        settled: Promise.resolve(),
      };
      return {
        ...outcome,
        completed: (async () => {
          await params.stopChildren?.(async () => true);
          return outcome;
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
});
