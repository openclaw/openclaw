import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pidAlive = vi.hoisted(() => ({
  isPidDefinitelyDead: vi.fn<(pid: number) => boolean>(),
  getFileLockProcessStartTime: vi.fn<(pid: number) => number | null>(),
}));

// Only the two ownership probes are stubbed; siblings (session locks, gateway
// lock) import the rest of this module and must keep the real implementations.
vi.mock("../../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/pid-alive.js")>()),
  ...pidAlive,
}));

// Observes the publish step without changing it: wraps the real store so a test
// can inspect the filesystem at the instant the rename is issued.
const storeSpy = vi.hoisted(() => ({
  onMove: null as ((from: string, to: string, rootDir: string) => void) | null,
}));

vi.mock("../file-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../file-store.js")>();
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
            move: async (from: string, to: string, moveOptions?: unknown) => {
              storeSpy.onMove?.(from, to, options.rootDir);
              return await (root.move as (...args: unknown[]) => Promise<void>)(
                from,
                to,
                moveOptions,
              );
            },
          };
        },
      };
    },
  };
});

const {
  collectEntrySpoolPaths,
  reclaimDeadGenerationSpoolArtifacts,
  releaseSpoolArtifacts,
  stageQueuePayloadMedia,
} = await import("./delivery-queue-media-spool.js");

const NONCE = "0".repeat(32);
const OTHER_NONCE = "1".repeat(32);

let stateDir: string;
let sourceDir: string;
let spoolRoot: string;

/** Materializes a generation directory holding one artifact, as a producer would. */
async function seedGeneration(params: {
  pid: number;
  startTime: number | "unknown";
  nonce?: string;
  artifact?: string;
}): Promise<{ generationPath: string; artifactPath: string }> {
  const name = `${params.pid}-${params.startTime}-${params.nonce ?? NONCE}`;
  const generationPath = path.join(spoolRoot, name);
  await fs.mkdir(generationPath, { recursive: true });
  const artifactPath = path.join(generationPath, params.artifact ?? "voice.ogg");
  await fs.writeFile(artifactPath, "audio-bytes");
  return { generationPath, artifactPath };
}

const exists = (target: string) =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

beforeEach(async () => {
  // Prod resolvers realpath their roots; macOS /var -> /private/var would break
  // raw mkdtemp comparisons.
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-state-")));
  sourceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-src-")));
  spoolRoot = path.join(stateDir, "delivery-queue-media");
  pidAlive.isPidDefinitelyDead.mockReset();
  pidAlive.getFileLockProcessStartTime.mockReset();
  storeSpy.onMove = null;
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

describe("generation reclaim", () => {
  it("keeps a live owner's artifacts even when they look ancient", async () => {
    const { artifactPath } = await seedGeneration({ pid: 4242, startTime: 900 });
    const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await fs.utimes(artifactPath, ancient, ancient);
    pidAlive.isPidDefinitelyDead.mockReturnValue(false);
    pidAlive.getFileLockProcessStartTime.mockReturnValue(900);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    // Age is never an ownership signal: a gateway idle for a year still owns its
    // undelivered media.
    expect(await exists(artifactPath)).toBe(true);
  });

  it("retains a generation whose owner cannot be verified", async () => {
    const { artifactPath } = await seedGeneration({ pid: 4243, startTime: 900 });
    // kill(0) did not prove absence (e.g. EPERM) and the identity is unreadable.
    pidAlive.isPidDefinitelyDead.mockReturnValue(false);
    pidAlive.getFileLockProcessStartTime.mockReturnValue(null);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    expect(await exists(artifactPath)).toBe(true);
  });

  it("retains a generation recorded without a process identity", async () => {
    const { artifactPath } = await seedGeneration({ pid: 4244, startTime: "unknown" });
    pidAlive.isPidDefinitelyDead.mockReturnValue(false);
    pidAlive.getFileLockProcessStartTime.mockReturnValue(1500);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    expect(await exists(artifactPath)).toBe(true);
  });

  it("reclaims an orphan whose owner is gone and whose row never appeared", async () => {
    const { generationPath, artifactPath } = await seedGeneration({ pid: 4245, startTime: 900 });
    pidAlive.isPidDefinitelyDead.mockReturnValue(true);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    expect(await exists(artifactPath)).toBe(false);
    expect(await exists(generationPath)).toBe(false);
  });

  it("keeps the exact path a pending row still references in a dead generation", async () => {
    const { generationPath, artifactPath } = await seedGeneration({ pid: 4246, startTime: 900 });
    const abandoned = path.join(generationPath, "abandoned.ogg");
    await fs.writeFile(abandoned, "no-row");
    pidAlive.isPidDefinitelyDead.mockReturnValue(true);

    await reclaimDeadGenerationSpoolArtifacts({
      retainPaths: new Set([artifactPath]),
      stateDir,
    });

    // The owner is gone, but a pending row still has to replay this artifact.
    expect(await exists(artifactPath)).toBe(true);
    expect(await exists(abandoned)).toBe(false);
    expect(await exists(generationPath)).toBe(true);
  });

  it("reclaims a generation whose PID was recycled by a different process", async () => {
    const { artifactPath } = await seedGeneration({ pid: 4247, startTime: 900 });
    // The PID is live, but it belongs to a process that booted later.
    pidAlive.isPidDefinitelyDead.mockReturnValue(false);
    pidAlive.getFileLockProcessStartTime.mockReturnValue(999_000);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    expect(await exists(artifactPath)).toBe(false);
  });

  it("collects a partial publish left by a crash between write and rename", async () => {
    const { artifactPath } = await seedGeneration({
      pid: 4248,
      startTime: 900,
      artifact: "half.ogg.part",
    });
    pidAlive.isPidDefinitelyDead.mockReturnValue(true);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    expect(await exists(artifactPath)).toBe(false);
  });

  it("ignores directories that do not carry a generation identity", async () => {
    const foreign = path.join(spoolRoot, "not-a-generation");
    await fs.mkdir(foreign, { recursive: true });
    const stranger = path.join(foreign, "keep.bin");
    await fs.writeFile(stranger, "not ours");
    pidAlive.isPidDefinitelyDead.mockReturnValue(true);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    expect(await exists(stranger)).toBe(true);
  });

  it("does not follow a symlink planted inside a dead generation", async () => {
    const outside = path.join(sourceDir, "precious.txt");
    await fs.writeFile(outside, "must survive");
    const { generationPath } = await seedGeneration({
      pid: 4249,
      startTime: 900,
      nonce: OTHER_NONCE,
    });
    await fs.symlink(outside, path.join(generationPath, "escape.ogg"));
    pidAlive.isPidDefinitelyDead.mockReturnValue(true);

    await reclaimDeadGenerationSpoolArtifacts({ retainPaths: new Set(), stateDir });

    expect(await exists(outside)).toBe(true);
  });
});

describe("release", () => {
  it("refuses to unlink a path outside the spool root", async () => {
    const outside = path.join(sourceDir, "not-ours.ogg");
    await fs.writeFile(outside, "bytes");

    await releaseSpoolArtifacts([outside, path.join(spoolRoot, "..", "escape.ogg")], stateDir);

    expect(await exists(outside)).toBe(true);
  });
});

describe("collectEntrySpoolPaths", () => {
  it("returns only spool-owned references", async () => {
    const spoolPath = path.join(spoolRoot, `1-2-${NONCE}`, "a.ogg");
    const paths = collectEntrySpoolPaths(
      [
        { mediaUrl: spoolPath },
        { mediaUrl: "https://example.com/a.ogg" },
        { mediaUrl: path.join(sourceDir, "b.ogg") },
      ],
      stateDir,
    );

    expect(paths).toEqual([spoolPath]);
  });
});

describe("staging", () => {
  const mediaAccessFor = (roots: string[]) => ({ localRoots: roots });

  it("copies a producer-owned source and rewrites only the queue payload", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");
    const livePayload = { text: "hi", mediaUrl: source };

    const result = await stageQueuePayloadMedia({
      payloads: [livePayload],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result.status).toBe("staged");
    if (result.status !== "staged") {
      return;
    }
    const staged = result.payloads[0]?.mediaUrl;
    expect(staged).toMatch(new RegExp(`^${spoolRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
    expect(await fs.readFile(staged as string, "utf8")).toBe("opus-bytes");
    // The live send keeps the original path and stays copy-free.
    expect(livePayload.mediaUrl).toBe(source);
    expect(result.artifacts).toEqual([staged]);
  });

  it("survives deletion of the producer's source", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });
    // Stand in for the producer's 5-minute temp cleanup / process exit.
    await fs.rm(source, { force: true });

    expect(result.status).toBe("staged");
    if (result.status !== "staged") {
      return;
    }
    expect(await fs.readFile(result.payloads[0]?.mediaUrl as string, "utf8")).toBe("opus-bytes");
  });

  it("leaves remote sources untouched", async () => {
    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: "https://example.com/a.ogg" }],
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result).toEqual({
      status: "staged",
      payloads: [{ mediaUrl: "https://example.com/a.ogg" }],
      artifacts: [],
    });
    expect(await exists(spoolRoot)).toBe(false);
  });

  it("never persists sensitive media as bytes or as a path", async () => {
    const source = path.join(sourceDir, "secret.ogg");
    await fs.writeFile(source, "private");

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source, sensitiveMedia: true }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result).toEqual({ status: "not-durable", reason: "sensitive-media" });
    // Nothing was written: no bytes to find and no path to hand to a row.
    expect(await exists(spoolRoot)).toBe(false);
  });

  it("stages a sensitive-flagged payload that carries no media reference", async () => {
    const result = await stageQueuePayloadMedia({
      payloads: [{ text: "no media here", sensitiveMedia: true }],
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result.status).toBe("staged");
  });

  it("throws when the source is outside the send's authorized roots", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");

    await expect(
      stageQueuePayloadMedia({
        payloads: [{ mediaUrl: source }],
        // The spool may never widen what the live send was allowed to read.
        mediaAccess: mediaAccessFor([path.join(stateDir, "elsewhere")]),
        maxBytes: 1024 * 1024,
        stateDir,
      }),
    ).rejects.toThrow();
  });

  it("never exposes the final artifact until the copy is complete", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");
    const atMove: { finalExisted: boolean; partSize: number }[] = [];
    storeSpy.onMove = (from, to, rootDir) => {
      // Sampled at the publish instant: the bytes are already whole in the part
      // file and the final name does not exist yet, so no reader or reclaim can
      // observe a truncated artifact under the published path.
      atMove.push({
        finalExisted: existsSync(path.join(rootDir, to)),
        partSize: statSync(path.join(rootDir, from)).size,
      });
    };

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result.status).toBe("staged");
    if (result.status !== "staged") {
      return;
    }
    expect(atMove).toEqual([{ finalExisted: false, partSize: "opus-bytes".length }]);
    // The publish leaves no scratch behind.
    const generation = path.dirname(result.artifacts[0] as string);
    expect(await fs.readdir(generation)).toHaveLength(1);
  });

  it("copies a repeated source once per entry", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");

    const result = await stageQueuePayloadMedia({
      payloads: [{ mediaUrl: source }, { mediaUrl: source }],
      mediaAccess: mediaAccessFor([sourceDir]),
      maxBytes: 1024 * 1024,
      stateDir,
    });

    expect(result.status).toBe("staged");
    if (result.status !== "staged") {
      return;
    }
    expect(result.artifacts).toHaveLength(1);
    expect(result.payloads[0]?.mediaUrl).toBe(result.payloads[1]?.mediaUrl);
  });
});
