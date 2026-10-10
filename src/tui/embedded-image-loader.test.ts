import "../test-utils/prepare-compiled-subprocesses.js";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { withIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import * as managedMedia from "../gateway/managed-image-attachments.js";
import * as sessionAgent from "../gateway/session-request-agent.js";
import * as sessions from "../gateway/session-utils.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

it("rejects a bound local image after its actor authority is revoked during thumbnail work", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const sessionKey = "agent:main:dashboard:incognito-local-image";
    let revoked = false;
    const authority = {
      assertCurrent() {
        if (revoked) {
          throw new Error("Image actor revoked");
        }
      },
    };
    const actor = await openIncognitoTestActor(state.env, authority);
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId: "private-image", updatedAt: 1, incognito: true },
    });
    const started = createDeferredCore();
    const thumbnail = createDeferredCore<Buffer>();
    vi.spyOn(managedMedia, "readManagedOutgoingImageThumbnail").mockImplementation(() => {
      started.resolve();
      return thumbnail.promise;
    });
    const sql = observeHostDataSql();
    let pending: Promise<unknown> | undefined;
    try {
      pending = withIncognitoSessionBinding({ actor }, () =>
        loadEmbeddedImage({
          sessionKey,
          source: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/11111111-1111-4111-8111-111111111111/full`,
          signal: new AbortController().signal,
        }),
      );
      void pending.catch(() => {});
      await Promise.race([started.promise, pending]);
      revoked = true;
      thumbnail.resolve(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6E9sAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      await expect(pending).rejects.toThrow("Image actor revoked");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      revoked = false;
      thumbnail.resolve(Buffer.alloc(0));
      await pending?.catch(() => {});
      await actor.release();
      await actor.close();
    }
  });
});
