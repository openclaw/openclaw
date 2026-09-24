import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import { readManagedOutgoingImageThumbnail } from "../../gateway/managed-image-attachments.js";
import * as mediaRecords from "../../gateway/managed-image-record-store.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import {
  captureChannelReadScope,
  withChannelReadAuthority,
} from "../../shared/channel-read-authority.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "outbound/deliver" ? { ...logger, warn } : logger;
    },
  };
});

describe("outbound media delivery transcript", () => {
  let stateDir: string;
  let mediaPath: string;
  let storePath: string;
  const sessionKey = "agent:main:plugin-media";
  const sessionId = "plugin-media-session";
  const imageBytes = createSolidPngBuffer(8, 8, { r: 18, g: 82, b: 142 });
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await cleanupSessionStateForTest({ stateDir });
      vi.unstubAllEnvs();
      cleanup();
    }),
  );

  beforeAll(async () => {
    stateDir = tempDirs.make("outbound-media-transcript-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    mediaPath = path.join(stateDir, "plugin-output", "chart.png");
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.mkdir(path.join(stateDir, "media", "outgoing", "originals"), { recursive: true });
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  function scope() {
    return { agentId: "main", sessionKey, sessionId, storePath };
  }

  function mirror(
    mediaUrl = mediaPath,
    expectedSessionId = sessionId,
    options: {
      idempotencyKey?: string;
      sensitiveMedia?: boolean;
      readFile?: (filePath: string) => Promise<Buffer>;
    } = {},
  ) {
    const delivery: DeliverOutboundPayloadsCoreParams = {
      cfg: { session: { store: storePath } },
      channel: "discord",
      to: "test-channel",
      payloads: [{ text: "Chart", mediaUrl }],
      mediaAccess: {
        localRoots: [path.dirname(mediaPath)],
        readFile: options.readFile ?? (async () => imageBytes),
      },
      mirror: {
        agentId: "main",
        sessionKey,
        expectedSessionId,
        idempotencyKey: options.idempotencyKey ?? "plugin-chart",
      },
    };
    return mirrorDeliveredPayloads({
      delivery,
      payloads: [{ text: "Chart", mediaUrls: [mediaUrl], sensitiveMedia: options.sensitiveMedia }],
      channel: delivery.channel,
      to: delivery.to,
    });
  }

  async function messages() {
    return readSessionMessagesAsync(scope(), {
      mode: "full",
      reason: "outbound media mirror regression",
    });
  }

  it("persists a retrievable display image and reuses its identity on delivery replay", async () => {
    await mirror();
    const persisted = (await loadTranscriptEvents(scope())).map(readTranscriptEventMessage);
    expect(persisted).toContainEqual(
      expect.objectContaining({ openclawDelivery: { mediaUrls: [mediaPath] } }),
    );
    const before = await messages();
    const displayed = projectChatDisplayMessages(before);
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]),
    });
    const records = await listManagedImageRecordEntries({ stateDir, sessionKey });
    expect(records, JSON.stringify({ warnings: warn.mock.calls, displayed })).toHaveLength(1);
    const original = records[0]!.record.original;
    expect(
      await fs.readFile(path.join(original.mediaRoot, original.mediaSubdir, original.mediaId)),
    ).toEqual(imageBytes);
    const imageBlock = (displayed[0] as { content: Array<Record<string, unknown>> }).content.find(
      (block) => block.type === "image",
    );
    expect(imageBlock?.artifactId).toBeTypeOf("string");
    const thumbnail = await readManagedOutgoingImageThumbnail({
      agentId: "main",
      sessionKey,
      artifactId: String(imageBlock?.artifactId),
      stateDir,
      maxBytes: 100_000,
      signal: new AbortController().signal,
    });
    expect(thumbnail).not.toBeNull();
    expect(thumbnail?.byteLength).toBeGreaterThan(0);

    await Promise.all([mirror(), mirror()]);
    expect(await messages()).toEqual(before);
    expect(await listManagedImageRecordEntries({ stateDir, sessionKey })).toEqual(records);

    warn.mockClear();
    await expect(
      mirror(path.join(stateDir, "different-source", "chart.png")),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("conflicts with the admitted message"),
      expect.objectContaining({ sessionKey }),
    );
    expect(await messages()).toEqual(before);
    expect(await listManagedImageRecordEntries({ stateDir, sessionKey })).toEqual(records);
  });

  it("does not turn a stale mirror target into a retryable channel delivery failure", async () => {
    const before = await messages();
    const records = await listManagedImageRecordEntries({ stateDir, sessionKey });
    warn.mockClear();
    await expect(mirror(mediaPath, "replaced-session")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("channel send already succeeded"),
      expect.objectContaining({ sessionKey }),
    );
    expect(await messages()).toEqual(before);
    expect(await listManagedImageRecordEntries({ stateDir, sessionKey })).toEqual(records);
  });

  it("does not copy sensitive payload media into retained transcript attachments", async () => {
    const records = await listManagedImageRecordEntries({ stateDir, sessionKey });
    const originalsDir = path.join(stateDir, "media", "outgoing", "originals");
    const files = await fs.readdir(originalsDir);
    const readFile = vi.fn(async () => imageBytes);
    await mirror(mediaPath, sessionId, {
      idempotencyKey: "sensitive-chart",
      sensitiveMedia: true,
      readFile,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(await listManagedImageRecordEntries({ stateDir, sessionKey })).toEqual(records);
    expect(await fs.readdir(originalsDir)).toEqual(files);
    const persisted = (await loadTranscriptEvents(scope())).map(readTranscriptEventMessage);
    expect(persisted).toContainEqual(
      expect.objectContaining({
        idempotencyKey: "sensitive-chart",
        openclawDelivery: { mediaUrls: [] },
      }),
    );
  });

  it("retains committed media when read authority is revoked during promotion", async () => {
    const existing = await listManagedImageRecordEntries({ stateDir, sessionKey });
    const uncommitted = vi.fn(async (_accepted: boolean) => {});
    let current = true;
    const attach = mediaRecords.attachManagedImageRecordToMessage;
    const promotion = vi
      .spyOn(mediaRecords, "attachManagedImageRecordToMessage")
      .mockImplementation((params) => {
        current = false;
        return attach(params);
      });
    try {
      await expect(
        withChannelReadAuthority(
          () => {
            if (!current) {
              throw new Error("plugin read authority revoked after commit");
            }
          },
          async () => {
            captureChannelReadScope()!.registerResource({
              key: "uncommitted-output",
              settle: uncommitted,
            });
            await mirror(mediaPath, sessionId, { idempotencyKey: "committed-before-revoke" });
          },
        ),
      ).rejects.toThrow("plugin read authority revoked after commit");
    } finally {
      promotion.mockRestore();
    }
    expect(uncommitted).toHaveBeenCalledExactlyOnceWith(false);
    const records = await listManagedImageRecordEntries({ stateDir, sessionKey });
    const committed = records.filter(
      ({ record }) => !existing.some((entry) => entry.record.attachmentId === record.attachmentId),
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]!.record).toMatchObject({
      retentionClass: "history",
      messageId: expect.any(String),
    });
    const original = committed[0]!.record.original;
    expect(
      await fs.readFile(path.join(original.mediaRoot, original.mediaSubdir, original.mediaId)),
    ).toEqual(imageBytes);
    const displayed = projectChatDisplayMessages(await messages());
    expect(displayed).toContainEqual(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            url: expect.stringContaining(committed[0]!.record.attachmentId),
          }),
        ]),
      }),
    );
  });

  it("discards media when read authority is revoked while the host reader is pending", async () => {
    const before = await messages();
    const records = await listManagedImageRecordEntries({ stateDir, sessionKey });
    const originalsDir = path.join(stateDir, "media", "outgoing", "originals");
    const files = await fs.readdir(originalsDir);
    let current = true;
    let mirroredWithoutThrowing = false;
    await expect(
      withChannelReadAuthority(
        () => {
          if (!current) {
            throw new Error("plugin read authority revoked");
          }
        },
        async () => {
          await mirror(mediaPath, sessionId, {
            idempotencyKey: "revoked-chart",
            readFile: async () => {
              await Promise.resolve();
              current = false;
              return imageBytes;
            },
          });
          mirroredWithoutThrowing = true;
        },
      ),
    ).rejects.toThrow("plugin read authority revoked");
    expect(mirroredWithoutThrowing).toBe(true);
    expect(await messages()).toEqual(before);
    expect(await listManagedImageRecordEntries({ stateDir, sessionKey })).toEqual(records);
    expect(await fs.readdir(originalsDir)).toEqual(files);
  });
});
