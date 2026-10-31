import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { createImageProcessor } from "../../media/media-services.js";
import { loadWebMedia } from "../../media/web-media.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import { loadPendingDeliveries } from "./delivery-queue.test-helpers.js";

const storeSpy = vi.hoisted(() => ({
  onMove: null as ((from: string, to: string, rootDir: string) => void) | null,
}));
vi.mock("@openclaw/fs-safe/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/store")>();
  return {
    ...actual,
    fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
      const store = actual.fileStore(options);
      return {
        ...store,
        root: async () => {
          const root = await store.root();
          return {
            ...root,
            move: async (...args: Parameters<typeof root.move>) => {
              storeSpy.onMove?.(args[0], args[1], options.rootDir);
              return await root.move(...args);
            },
          };
        },
      };
    },
  };
});

const { pruneOrphanedDeliveryQueueMedia, releaseSpoolArtifacts, stageQueuePayloadMedia } =
  await import("./delivery-queue-media-spool.js");
const { enqueueDelivery } = await import("./delivery-queue-storage.js");
const { pruneExpiredDeliveryQueueTombstones } = await import("../delivery-queue-sqlite.js");
const { loadDeliveryQueueEntry, seedDeliveryQueueEntry } =
  await import("../delivery-queue-sqlite.test-support.js");
const {
  createDeliveryQueueMediaRetention,
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} = await import("./delivery-queue-media-staging.js");

const DAY_MS = 24 * 60 * 60_000;
const ARTIFACT_A = "00000000-0000-4000-8000-000000000001.ogg";
const ARTIFACT_B = "00000000-0000-4000-8000-000000000002.ogg";
const PART_ARTIFACT = "00000000-0000-4000-8000-000000000003.ogg.part";
// Published 2026.9.6 recognizes only this grammar for both GC and explicit release.
const PUBLISHED_ARTIFACT_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[A-Za-z0-9]{1,10})?(?:\.part)?$/;

let stateDir: string;
let sourceDir: string;
let source: string;
let spoolRoot: string;

async function seedArtifact(name: string, ageMs = 30 * DAY_MS): Promise<string> {
  await fs.mkdir(spoolRoot, { recursive: true });
  const artifactPath = path.join(spoolRoot, name);
  await fs.writeFile(artifactPath, "audio-bytes");
  const timestamp = new Date(Date.now() - ageMs);
  await fs.utimes(artifactPath, timestamp, timestamp);
  return artifactPath;
}

const rawStage = (options: Partial<Parameters<typeof stageQueuePayloadMedia>[0]> = {}) =>
  stageQueuePayloadMedia({
    payloads: [{ mediaUrl: source }],
    mediaAccess: { localRoots: [sourceDir] },
    maxBytes: 1024 * 1024,
    stateDir,
    ...options,
  });
async function stage(options: Parameters<typeof rawStage>[0] = {}) {
  const result = await rawStage(options);
  if (result.status !== "staged") {
    throw new Error("Expected staged media");
  }
  return result;
}
function expectArtifacts(present: string[], absent: string[]) {
  expect(present.map(existsSync)).toEqual(present.map(() => true));
  expect(absent.map(existsSync)).toEqual(absent.map(() => false));
}
const enqueue = (
  payloads: Parameters<typeof enqueueDelivery>[0]["payloads"],
  mediaStageId?: string,
) => enqueueDelivery({ channel: "matrix", to: "!room:example", payloads }, stateDir, mediaStageId);

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-state-")));
  sourceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-src-")));
  spoolRoot = path.join(stateDir, "delivery-queue-media");
  source = path.join(sourceDir, "voice.ogg");
  await fs.writeFile(source, "opus-bytes");
  storeSpy.onMove = null;
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

it("reclaims expired custody off-thread and preserves pending media across reopen", async () => {
  await pruneOrphanedDeliveryQueueMedia({ stateDir });
  const retained = await seedArtifact(ARTIFACT_A);
  const orphan = await seedArtifact(ARTIFACT_B);
  const fresh = await seedArtifact(PART_ARTIFACT, DAY_MS / 2);
  const staged = await seedArtifact("00000000-0000-4000-8000-000000000004.ogg");
  await createDeliveryQueueMediaRetention([staged], "outbound-media-stage", stateDir);
  const id = await enqueue([{ mediaUrl: retained }]);
  seedDeliveryQueueEntry({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    entry: { id: "expired-receipt", enqueuedAt: Date.now() - 31 * DAY_MS, retryCount: 0 },
    status: "completed",
    stateDir,
  });
  await pruneOrphanedDeliveryQueueMedia({ stateDir });
  await closeOpenClawStateDatabaseAsync();

  const mainSql = observeMainThreadSql();
  try {
    await pruneExpiredDeliveryQueueTombstones(stateDir);
    await pruneOrphanedDeliveryQueueMedia({ stateDir });
    mainSql.expectIdle();
  } finally {
    mainSql.restore();
    await closeOpenClawStateDatabaseAsync();
  }

  expect(await loadPendingDeliveries(stateDir)).toMatchObject([{ id }]);
  expect(
    loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, "expired-receipt", stateDir, "all"),
  ).toBeNull();
  expectArtifacts([retained, staged, fresh], [orphan]);
});

it("retains media from generation-bound and migration namespaces in one inventory", async () => {
  const retained = await Promise.all(
    (
      [
        [COMMAND_OWNER_OUTBOUND_DELIVERY_QUEUE_NAME, "c1-"],
        [OUTBOUND_DELIVERY_QUEUE_NAME, ""],
        ["outbound-session-generation-v1", "g1-"],
        [LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, ""],
        [OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, ""],
        [OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, ""],
      ] as const
    ).map(async ([queueName, prefix], index) => {
      const artifact = await seedArtifact(
        `${prefix}00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}.ogg`,
      );
      const payload = { mediaUrl: artifact };
      seedDeliveryQueueEntry({
        queueName,
        entry: {
          id: `retained-${index}`,
          enqueuedAt: Date.now(),
          retryCount: 0,
          ...(prefix
            ? { preparedBatch: { entries: [{ status: "accepted", payload }] } }
            : { payloads: [payload] }),
        },
        stateDir,
      });
      return artifact;
    }),
  );
  const orphan = await seedArtifact(ARTIFACT_B);
  const generationOrphan = await seedArtifact(`g1-${ARTIFACT_B}`);
  const ownerOrphan = await seedArtifact(`c1-${ARTIFACT_B}`);

  await pruneOrphanedDeliveryQueueMedia({ stateDir });

  expectArtifacts(retained, [orphan, generationOrphan, ownerOrphan]);
});

it("reclaims stale partial writes but ignores foreign files and symlinks", async () => {
  const partial = await seedArtifact(PART_ARTIFACT, 2 * DAY_MS);
  const generationPartial = await seedArtifact(`g1-${PART_ARTIFACT}`, 2 * DAY_MS);
  const freshGenerationPartial = await seedArtifact(`g1-${ARTIFACT_B}.part`, DAY_MS / 2);
  const foreign = await seedArtifact("operator-note.txt", 2 * DAY_MS);
  const unknownFormat = await seedArtifact(`g2-${PART_ARTIFACT}`, 2 * DAY_MS);
  await fs.symlink(source, path.join(spoolRoot, ARTIFACT_A));

  await pruneOrphanedDeliveryQueueMedia({ stateDir });

  expectArtifacts([freshGenerationPartial, foreign, unknownFormat], [partial, generationPartial]);
  expect(await fs.readFile(source, "utf8")).toBe("opus-bytes");
});

it("expires abandoned stages before or after file publication without rescanning quiet inventory", async () => {
  await pruneOrphanedDeliveryQueueMedia({ stateDir });
  using requests = vi.spyOn(Worker.prototype, "postMessage");
  await pruneOrphanedDeliveryQueueMedia({ stateDir });
  expect(requests).not.toHaveBeenCalled();
  expect(existsSync(spoolRoot)).toBe(false);

  const staged = await stage({ payloads: [{ mediaUrl: source, audioAsVoice: true }] });
  const artifact = path.join(spoolRoot, ARTIFACT_A);
  const mediaStageId = await createDeliveryQueueMediaRetention(
    [artifact],
    "outbound-media-stage",
    stateDir,
  );
  requests.mockClear();
  await pruneOrphanedDeliveryQueueMedia({ stateDir });
  expect(requests).not.toHaveBeenCalled();
  expect(existsSync(artifact)).toBe(false);
  await pruneOrphanedDeliveryQueueMedia({ stateDir, nowMs: Date.now() + 2 * DAY_MS });
  for (const entry of [staged, { payloads: [{ mediaUrl: artifact }], mediaStageId }]) {
    assert(entry.mediaStageId);
    expect(
      loadDeliveryQueueEntry(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, entry.mediaStageId, stateDir),
    ).toBeNull();
    await expect(enqueue(entry.payloads, entry.mediaStageId)).rejects.toThrow(
      "media stage expired before enqueue",
    );
  }
  await expect(fs.stat(staged.artifacts[0] as string)).rejects.toThrow();
  expect(await loadPendingDeliveries(stateDir)).toEqual([]);
});

it("reports failed releases, continues cleanup, and ignores missing or outside paths", async () => {
  const generationFinal = await seedArtifact(`g1-${ARTIFACT_A}`, 0);
  const generationPartial = await seedArtifact(`g1-${PART_ARTIFACT}`, 0);
  const stuck = path.join(spoolRoot, ARTIFACT_A);
  await fs.mkdir(stuck);
  await fs.writeFile(path.join(stuck, "retained.txt"), "keep");
  const capture = createWarnLogCapture("spool-release");
  try {
    await releaseSpoolArtifacts(
      [stuck, generationFinal, generationPartial, path.join(spoolRoot, ARTIFACT_B), source],
      stateDir,
    );
    expectArtifacts([source, stuck], [generationFinal, generationPartial]);
    expect(
      await capture.findText(`failed to remove delivery queue media artifact ${ARTIFACT_A}:`),
    ).toBeDefined();
    expect(await capture.findText(ARTIFACT_B)).toBeUndefined();
  } finally {
    capture.cleanup();
  }
});
it("stages local media while a competing writer needs the host to release its lock", async () => {
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const writer = new DatabaseSync(database.path);
  try {
    writer.exec("BEGIN IMMEDIATE");
    // A worker can hold this lock while waiting for host admission. Staging
    // must yield so the host can let that writer finish.
    const staged = stage();
    writer.exec("COMMIT");
    const result = await staged;
    expect(await fs.readFile(result.artifacts[0]!, "utf8")).toBe("opus-bytes");
    const id = await enqueue(result.payloads, result.mediaStageId);
    expect(await loadPendingDeliveries(stateDir)).toMatchObject([
      { id, preparedBatch: { entries: [{ payload: { mediaUrl: result.artifacts[0] } }] } },
    ]);
  } finally {
    if (writer.isTransaction) {
      writer.exec("ROLLBACK");
    }
    await closeOpenClawStateDatabaseAsync();
    writer.close();
  }
});

it("replays converted PNG bytes with a matching public name and unchanged spool custody", async () => {
  const sourceBytes = (
    await createImageProcessor().encode(
      createSolidPngBuffer(2050, 2, { r: 40, g: 90, b: 180, a: 96 }),
      { format: "webp" },
    )
  ).data;
  expect(sourceBytes.toString("ascii", 8, 12)).toBe("WEBP");
  const imagePath = path.join(sourceDir, "transparent.webp");
  await fs.writeFile(imagePath, sourceBytes);
  const staged = await stage({ payloads: [{ mediaUrl: imagePath }] });
  await enqueue(staged.payloads, staged.mediaStageId);
  await fs.rm(imagePath);

  const queued = (await loadPendingDeliveries(stateDir))[0]?.preparedBatch.entries[0];
  expect(queued?.status).toBe("accepted");
  if (!queued || queued.status !== "accepted" || !queued.payload.mediaUrl) {
    throw new Error("Expected queued image artifact");
  }
  const replayPath = queued.payload.mediaUrl;
  expect(replayPath).toBe(staged.artifacts[0]);
  // SQLite owns this preplanned path; only public image metadata changes.
  expect(path.extname(replayPath)).toBe(".webp");
  const encodedBytes = await fs.readFile(replayPath);
  expect(encodedBytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const replayed = await loadWebMedia(replayPath, {
    maxBytes: 1024 * 1024,
    localRoots: [spoolRoot],
  });
  expect([replayed.kind, replayed.contentType, replayed.fileName]).toEqual([
    "image",
    "image/png",
    `${path.basename(replayPath, ".webp")}.png`,
  ]);
  expect(replayed.buffer).toEqual(encodedBytes);
  expect(await fs.readFile(replayPath)).toEqual(encodedBytes);
});

it("uses the live send's local-read capability", async () => {
  const mediaAccess = { localRoots: [path.join(stateDir, "elsewhere")] };
  await expect(rawStage({ mediaAccess })).rejects.toThrow();
});

it.each([
  [undefined, ""],
  ["session-generation-v1", "g1-"],
  ["command-owner-v1", "c1-"],
] as const)(
  "publishes complete media with older-reader-compatible custody (%s)",
  async (artifactFormat, prefix) => {
    const atMove: [boolean, number][] = [];
    storeSpy.onMove = (from, to, rootDir) => {
      const knownToPublishedReader = artifactFormat === undefined;
      expect(PUBLISHED_ARTIFACT_NAME_RE.test(from)).toBe(knownToPublishedReader);
      expect(PUBLISHED_ARTIFACT_NAME_RE.test(to)).toBe(knownToPublishedReader);
      expect(from).toBe(`${to}.part`);
      if (artifactFormat) {
        expect(to).toMatch(new RegExp(`^${prefix}[0-9a-f-]{36}\\.ogg$`));
      }
      atMove.push([existsSync(path.join(rootDir, to)), statSync(path.join(rootDir, from)).size]);
    };

    await stage({ artifactFormat });
    expect(atMove).toEqual([[false, "opus-bytes".length]]);
    expect(await fs.readdir(spoolRoot)).toHaveLength(1);
  },
);

it("cleans earlier copies when a later source fails", async () => {
  const payloads = [{ mediaUrls: [source, path.join(sourceDir, "missing.ogg")] }];
  await expect(rawStage({ payloads })).rejects.toThrow();

  expect(await fs.readdir(spoolRoot).catch(() => [])).toEqual([]);
});

it("preserves blank media slots and copies repeated local media once", async () => {
  const result = await stage({
    payloads: [{ mediaUrl: " ", mediaUrls: ["", source, source, "  "] }],
  });
  expect(result.artifacts).toHaveLength(1);
  expect(result.payloads[0]).toEqual({
    mediaUrl: " ",
    mediaUrls: ["", result.artifacts[0], result.artifacts[0], "  "],
  });
});
