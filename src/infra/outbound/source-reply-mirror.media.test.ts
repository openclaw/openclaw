import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  appendExactAssistantMessageToSessionTranscript,
  type SessionTranscriptAssistantMessage,
} from "../../config/sessions/transcript.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { mirrorDeliveredSourceReplyToTranscript as mirror } from "./source-reply-mirror.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

async function withSource(
  run: (input: Parameters<typeof mirror>[0], read: () => Promise<unknown[]>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:main";
    const sessionId = "source-media";
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg = {
      session: { store: storePath },
      agents: { defaults: { workspace: state.workspaceDir } },
    };
    setRuntimeConfigSnapshot(cfg);
    const plugin = createOutboundTestPlugin({
      id: "telegram",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "telegram", messageId: "unused" }),
      },
    });
    plugin.messaging = { normalizeTarget: (target) => target };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await fs.mkdir(state.workspaceDir, { recursive: true });
    const mediaUrl = path.join(state.workspaceDir, "chart.png");
    await fs.writeFile(mediaUrl, createSolidPngBuffer(2, 2, { r: 20, g: 100, b: 180 }));
    const input: Parameters<typeof mirror>[0] = {
      action: "send",
      channel: "telegram",
      actionParams: { target: "123" },
      cfg,
      sessionKey,
      sessionId,
      agentId: "main",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "123",
        currentMessagingTarget: "123",
        currentChatType: "direct",
      },
      deliveredPayload: { ok: true, messageId: "confirmed", chatId: "123" },
      deliveredPayloads: [{ text: "Chart", mediaUrl }],
      mediaAccess: {
        workspaceDir: state.workspaceDir,
        localRoots: [state.workspaceDir],
        readFile: vi.fn((file) => fs.readFile(file)),
      },
      idempotencyKey: "confirmed-image",
    };
    const read = async () =>
      (await loadTranscriptEvents({ sessionKey, sessionId, storePath }))
        .map(readTranscriptEventMessage)
        .filter(Boolean);
    await run(input, read);
  });
}

it("reuses accepted attachment custody on concurrent replay and rejects conflicting media", () =>
  withSource(async (input, read) => {
    expect(await Promise.all([mirror(input), mirror(input)])).toEqual([true, true]);
    const before = await read();
    expect(before).toHaveLength(1);
    const records = await listManagedImageRecordEntries({ sessionKey: input.sessionKey });
    expect(records).toHaveLength(1);
    expect(records[0]?.record.messageId).toBeTruthy();
    expect(input.mediaAccess?.readFile).toHaveBeenCalledOnce();
    expect(await mirror(input)).toBe(true);
    await expect(
      mirror({ ...input, deliveredPayloads: [{ text: "Chart", mediaUrl: "/other/chart.png" }] }),
    ).rejects.toThrow("conflicts with the admitted message");
    expect(await read()).toEqual(before);
    expect(await listManagedImageRecordEntries({ sessionKey: input.sessionKey })).toEqual(records);
  }));

it.each([false, true])("keeps relative media within the sender boundary (denied=%s)", (denied) =>
  withSource(async (input) => {
    const cwdDir = await fs.mkdtemp(path.join(process.cwd(), ".source-media-"));
    try {
      const source = path.relative(process.cwd(), path.join(cwdDir, "chart.png"));
      const workspace = expectDefined(input.mediaAccess?.workspaceDir, "sender workspace");
      const senderPath = path.join(workspace, source);
      const image = createSolidPngBuffer(3, 2, { r: 20, g: 100, b: 180 });
      await fs.mkdir(path.dirname(senderPath), { recursive: true });
      await fs.writeFile(senderPath, image);
      await fs.writeFile(
        path.join(cwdDir, "chart.png"),
        createSolidPngBuffer(4, 2, { r: 200, g: 20, b: 20 }),
      );
      const readFile = vi.fn(async (file: string) => {
        expect(file).toBe(senderPath);
        if (denied) {
          throw new Error("sender denied");
        }
        return await fs.readFile(file);
      });
      input.mediaAccess = { ...input.mediaAccess, readFile };
      input.deliveredPayloads = [{ text: "Chart", mediaUrl: source }];
      expect(await mirror(input)).toBe(true);
      expect(readFile).toHaveBeenCalledOnce();
      const records = await listManagedImageRecordEntries({ sessionKey: input.sessionKey });
      expect(records).toHaveLength(denied ? 0 : 1);
      if (!denied) {
        const { original } = expectDefined(records[0], "sender attachment").record;
        expect(
          await fs.readFile(path.join(original.mediaRoot, original.mediaSubdir, original.mediaId)),
        ).toEqual(image);
      }
    } finally {
      await fs.rm(cwdDir, { recursive: true, force: true });
    }
  }),
);

it("preserves a published filename-only mirror on replay without retroactively ingesting its file", () =>
  withSource(async (input, read) => {
    // Literal v2026.11.3 mirror shape; do not seed upgrade evidence with today's constructor.
    const published: SessionTranscriptAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Chart\nchart.png" }],
      openclawDelivery: {
        mediaUrls: [expectDefined(input.deliveredPayloads?.[0]?.mediaUrl, "source media")],
      },
      api: "openclaw-transcript",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    };
    await appendExactAssistantMessageToSessionTranscript({
      agentId: input.agentId,
      sessionKey: expectDefined(input.sessionKey, "source session"),
      expectedSessionId: input.sessionId,
      message: published,
      idempotencyKey: input.idempotencyKey,
      config: input.cfg,
    });
    const before = await read();
    expect(await mirror(input)).toBe(true);
    expect(await read()).toEqual(before);
    expect(input.mediaAccess?.readFile).not.toHaveBeenCalled();
    expect(await listManagedImageRecordEntries({ sessionKey: input.sessionKey })).toEqual([]);
  }));

it.each(["sensitive", "reader-denied", "cancelled", "cancelled-during-preparation"])(
  "does not acquire attachments when %s",
  (kind) =>
    withSource(async (input, read) => {
      const abort = new AbortController();
      if (kind === "sensitive") {
        input.deliveredPayloads = expectDefined(input.deliveredPayloads, "source payloads").map(
          (payload) => Object.assign({}, payload, { sensitiveMedia: true }),
        );
      }
      if (kind === "reader-denied") {
        input.mediaAccess = {
          localRoots: input.mediaAccess?.localRoots,
          readFile: async () => {
            throw new Error("sender denied");
          },
        };
      }
      if (kind === "cancelled") {
        abort.abort(new Error("cancelled"));
        input.abortSignal = abort.signal;
      }
      if (kind === "cancelled-during-preparation") {
        const payload = expectDefined(input.deliveredPayloads?.[0], "source payload");
        input.deliveredPayloads = [
          payload,
          { ...payload, mediaUrl: payload.mediaUrl + ".second.png" },
        ];
        const image = await fs.readFile(expectDefined(payload.mediaUrl, "source image"));
        let reads = 0;
        input.abortSignal = abort.signal;
        input.mediaAccess = {
          ...input.mediaAccess,
          readFile: async () => {
            if (++reads === 2) {
              abort.abort(new Error("cancelled during preparation"));
            }
            return image;
          },
        };
      }
      if (kind.startsWith("cancelled")) {
        await expect(mirror(input)).rejects.toThrow("cancelled");
        expect(await read()).toEqual([]);
      } else {
        expect(await mirror(input)).toBe(true);
        expect(await read()).toHaveLength(1);
      }
      expect(await listManagedImageRecordEntries({ sessionKey: input.sessionKey })).toEqual([]);
    }),
);

it("retains committed attachment custody when the enclosing read is cancelled", () =>
  withSource(async (input, read) => {
    const abort = new AbortController();
    await expect(
      withChannelReadAuthority(
        () => abort.signal.throwIfAborted(),
        async () => {
          expect(await mirror(input)).toBe(true);
          abort.abort(new Error("cancelled after commit"));
        },
        abort.signal,
      ),
    ).rejects.toThrow("cancelled after commit");
    expect(await read()).toHaveLength(1);
    const records = await listManagedImageRecordEntries({ sessionKey: input.sessionKey });
    expect(records).toHaveLength(1);
    const record = expectDefined(records[0], "committed attachment").record;
    expect(record.messageId).toBeTruthy();
    expect(
      (
        await fs.readFile(
          path.join(
            record.original.mediaRoot,
            record.original.mediaSubdir,
            record.original.mediaId,
          ),
        )
      ).length,
    ).toBeGreaterThan(0);
  }));
