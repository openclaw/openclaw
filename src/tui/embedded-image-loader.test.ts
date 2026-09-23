import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import * as managedMedia from "../gateway/managed-image-attachments.js";
import * as sessionAgent from "../gateway/session-request-agent.js";
import * as sessions from "../gateway/session-utils.js";
import { loadEmbeddedImage } from "./embedded-image-loader.js";

afterEach(() => vi.restoreAllMocks());

it("keeps a cancelled local image load pending until the thumbnail owner settles", async () => {
  const sessionKey = "agent:main:images";
  const attachmentId = "11111111-1111-4111-8111-111111111111";
  vi.spyOn(sessionAgent, "resolveRequestedSessionAgentId").mockReturnValue({
    ok: true,
    agentId: "main",
  });
  vi.spyOn(sessions, "loadGatewaySessionEntryReadOnly").mockReturnValue({
    cfg: {},
    agentId: "main",
    canonicalKey: sessionKey,
    entry: { sessionId: "image-session", updatedAt: 0 },
    storePath: "/tmp/tui-image-test.sqlite",
    store: {},
    storeKeys: [sessionKey],
    legacyKey: undefined,
  });
  let completeThumbnail!: (value: Buffer) => void;
  const thumbnail = new Promise<Buffer>((resolve) => {
    completeThumbnail = resolve;
  });
  let startThumbnail!: () => void;
  const started = new Promise<void>((resolve) => {
    startThumbnail = resolve;
  });
  vi.spyOn(managedMedia, "readManagedOutgoingImageThumbnail").mockImplementation(() => {
    startThumbnail();
    return thumbnail;
  });
  const controller = new AbortController();
  const pending = loadEmbeddedImage({
    sessionKey,
    source: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
    signal: controller.signal,
  });
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await Promise.race([started, pending]);
    controller.abort();
    await setImmediate();
    expect(settled).toBe(false);
    completeThumbnail(Buffer.alloc(0));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    completeThumbnail(Buffer.alloc(0));
    await pending.catch(() => {});
  }
});
