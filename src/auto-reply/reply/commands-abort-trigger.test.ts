// Tests abort trigger command parsing and cancellation requests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleAbortTrigger } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";

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

function buildAbortParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: "stop",
      rawBodyNormalized: "stop",
      isAuthorizedSender: false,
      senderIsOwner: false,
      senderId: "unauthorized",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "unauthorized",
      to: "bot",
    },
    sessionKey: "agent:main:main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      abortedLastRun: false,
    },
    sessionStore: {
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    },
  } as unknown as HandleCommandsParams;
}

describe("handleAbortTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abortSessionRunTargetWithOutcomeMock.mockImplementation((params) => {
      const outcome = {
        aborted: false,
        alreadyFinalizing: false,
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
          await params.recordAbortTarget?.({ recordCutoff: false });
          return outcome;
        })(),
      };
    });
  });

  it("rejects unauthorized natural-language abort triggers", async () => {
    const result = await handleAbortTrigger(buildAbortParams(), true);
    expect(result).toEqual({ shouldContinue: false });
    expect(abortSessionRunTargetWithOutcomeMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
  });

  it("reports a finalizing run without persisting abort state", async () => {
    const params = buildAbortParams();
    params.command.isAuthorizedSender = true;
    params.command.senderIsOwner = true;
    abortSessionRunTargetWithOutcomeMock.mockImplementation((abortParams) => {
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
          await abortParams.stopChildren?.(async () => true);
          return outcome;
        })(),
      };
    });
    const result = await handleAbortTrigger(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Agent reply is already finalizing and can no longer be aborted." },
    });
    expect(abortSessionRunTargetWithOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hookContext: expect.objectContaining({
          sessionKey: "agent:main:main",
          commandSource: "whatsapp",
          senderId: "unauthorized",
        }),
      }),
    );
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(setAbortMemoryMock).not.toHaveBeenCalled();
  });
});
