/**
 * Production-path proof that sessions.get caps oversized numeric limits before
 * transcript reads (same hard cap family as chat.history / sessions-history HTTP).
 */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const { readRecentMock } = vi.hoisted(() => ({
  readRecentMock: vi.fn(async (_scope: unknown, _opts?: unknown) => ({
    messages: [] as unknown[],
    totalMessages: 0,
  })),
}));

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readRecentSessionMessagesWithStatsAsync: readRecentMock,
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionStoreTargetWithStore: () => ({
      agentId: "main",
      canonicalKey: "main",
      storePath: "/tmp/sessions.json",
      storeKeys: ["main"],
      store: {
        main: { sessionId: "sess-main", updatedAt: Date.now() },
      },
    }),
  };
});

import { sessionsHandlers } from "./sessions.js";

function createContext(): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
  } as unknown as GatewayRequestContext;
}

function createRespond(): RespondFn {
  return vi.fn() as unknown as RespondFn;
}

describe("sessions.get message limit cap", () => {
  beforeEach(() => {
    readRecentMock.mockClear();
  });

  it("caps Number.MAX_SAFE_INTEGER before transcript reads", async () => {
    const respond = createRespond();
    await expectDefined(
      sessionsHandlers["sessions.get"],
      'sessionsHandlers["sessions.get"] test invariant',
    )({
      req: { id: "req-sessions-get-limit" } as never,
      params: { key: "main", limit: Number.MAX_SAFE_INTEGER },
      respond,
      context: createContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, { messages: [] }, undefined);
    expect(readRecentMock).toHaveBeenCalledTimes(1);
    expect(readRecentMock.mock.calls[0]?.[1]).toEqual({
      maxMessages: 1000,
      maxLines: 20020,
      allowResetArchiveFallback: true,
    });
  });
});
