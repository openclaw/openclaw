import { beforeEach, expect, it, vi } from "vitest";
import { handleAbortTrigger } from "./commands-session-abort.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const { persistAbortTargetEntryMock, abortSessionRunTargetWithOutcomeMock } = vi.hoisted(() => ({
  persistAbortTargetEntryMock: vi.fn(),
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

// mock-isolation: Observe abort writes without loading session persistence into this command test.
vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
  resolveCommandSessionEntryForKey: vi.fn(() => ({ entry: undefined, key: "agent:main:main" })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  abortSessionRunTargetWithOutcomeMock.mockImplementation((params) => ({
    completed: (async () => {
      await params.stopChildren?.(async () => true);
      return { alreadyFinalizing: true, childrenStopped: 0, childFailures: 0 };
    })(),
  }));
});

it.each([false, true])(
  "handles authorized=%s aborts without persisting state",
  async (authorized) => {
    const params = buildPluginsCommandParams({
      commandBodyNormalized: "stop",
      cfg: { commands: { text: true }, channels: { whatsapp: { allowFrom: ["*"] } } },
    });
    params.command.isAuthorizedSender = authorized;
    params.command.senderIsOwner = authorized;
    params.sessionKey = "agent:main:main";
    const result = await handleAbortTrigger(params, true);
    expect(result).toEqual(
      authorized
        ? {
            shouldContinue: false,
            reply: { text: "Agent reply is already finalizing and can no longer be aborted." },
          }
        : { shouldContinue: false },
    );
    if (!authorized) {
      expect(abortSessionRunTargetWithOutcomeMock).not.toHaveBeenCalled();
    }
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
  },
);
