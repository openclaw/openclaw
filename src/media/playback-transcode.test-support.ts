import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

type Playback = typeof import("./playback-transcode.js");
type SourceParams = Parameters<Playback["resolvePlaybackTranscode"]>[0];

export async function readPlaybackSource(filePath: string) {
  const sourcePath = await fs.realpath(filePath);
  const { size, mtimeMs, ctimeMs } = await fs.stat(sourcePath);
  return {
    sourcePath,
    sourceStat: {
      size,
      mtimeMs,
      ctimeMs,
      exactIdentity: await fs.stat(sourcePath, { bigint: true }),
    },
  };
}

export function usePlaybackFixture(prefix: string, mocks: string[]) {
  let playback: Playback;
  let home: TempHomeEnv;
  beforeAll(async () => {
    vi.resetModules();
    home = await createTempHomeEnv(prefix);
    playback = await import("./playback-transcode.js");
  });
  afterAll(async () => {
    try {
      await waitForPlaybackSourceCleanup();
      await home.restore();
    } finally {
      for (const module of mocks) {
        vi.doUnmock(module);
      }
      vi.resetModules();
    }
  });
  return {
    async createSource(fileName: string, contents: string | Uint8Array = "source") {
      const filePath = path.join(home.home, fileName);
      await fs.writeFile(filePath, contents);
      return await readPlaybackSource(filePath);
    },
    resolveTranscode: (params: SourceParams) => playback.resolvePlaybackTranscode(params),
    resolveMetadata: (params: SourceParams) => playback.resolvePlaybackMetadataForSource(params),
  };
}

const pendingSourceCleanup = new Set<Promise<void>>();

// The outer source descriptor closes after workspace disposal and cache publication.
// Track actual native opens/disposal, not the earlier ffmpeg completion.
export async function observePlaybackSourceOpen(
  pending: ReturnType<typeof import("../infra/fs-safe.js").openLocalFileSafely>,
) {
  const closed = createDeferred();
  pendingSourceCleanup.add(closed.promise);
  const finished = () => {
    pendingSourceCleanup.delete(closed.promise);
    closed.resolve();
  };
  try {
    const opened = await pending;
    const dispose = opened[Symbol.asyncDispose].bind(opened);
    opened[Symbol.asyncDispose] = async () => {
      try {
        await dispose();
      } finally {
        finished();
      }
    };
    return opened;
  } catch (error) {
    finished();
    throw error;
  }
}

// Stop issuing requests and release fixture gates first. Physical source cleanup
// precedes only synchronous pool/failure bookkeeping; inspect outcomes via the resolver.
export async function waitForPlaybackSourceCleanup(mode: "next" | "all" = "all"): Promise<void> {
  const sources = [...pendingSourceCleanup];
  if (sources.length > 0) {
    await (mode === "next" ? Promise.race(sources) : Promise.all(sources));
  }
}
