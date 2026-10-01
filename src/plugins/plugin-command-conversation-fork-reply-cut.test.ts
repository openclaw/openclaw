import { beforeEach, describe, expect, it, vi } from "vitest";
import { forkReplySession } from "./plugin-command-conversation-fork-reply-cut.js";

const mocks = vi.hoisted(() => ({
  worker: vi.fn(async () => ({ status: "created" })),
  native: vi.fn(async () => ({ status: "created" })),
}));

vi.mock("../config/sessions/session-accessor.sqlite-message-cut-worker.js", () => ({
  forkSessionAtMessageInWorker: mocks.worker,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  forkSessionAtMessage: mocks.native,
}));

describe("reply fork writer selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { incognito: false, selected: "worker" },
    { incognito: true, selected: "native" },
  ] as const)(
    "routes incognito=$incognito to the $selected owner",
    async ({ incognito, selected }) => {
      const params = {
        sessionKey: "agent:main:source",
        entryId: "user-1",
        targetKey: "agent:main:fork",
      };
      const expected = { sessionId: "source-id", lifecycleRevision: "source-rev" };
      await expect(forkReplySession(params, expected, incognito)).resolves.toEqual({
        status: "created",
      });
      expect(mocks[selected]).toHaveBeenCalledWith(params, expected);
      expect(mocks[incognito ? "worker" : "native"]).not.toHaveBeenCalled();
    },
  );
});
