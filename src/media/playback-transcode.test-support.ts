import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

type Playback = typeof import("./playback-transcode.js");
type SourceParams = Parameters<Playback["resolvePlaybackTranscode"]>[0];

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
      await home.restore();
    } finally {
      for (const module of mocks) {
        vi.doUnmock(module);
      }
      vi.resetModules();
    }
  });
  async function readSource(filePath: string) {
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
  return {
    readSource,
    async createSource(fileName: string, contents: string | Uint8Array = "source") {
      const filePath = path.join(home.home, fileName);
      await fs.writeFile(filePath, contents);
      return await readSource(filePath);
    },
    resolveTranscode: (params: SourceParams) => playback.resolvePlaybackTranscode(params),
    resolveMetadata: (params: SourceParams) => playback.resolvePlaybackMetadataForSource(params),
  };
}

type PlaybackTranscodeTestApi = {
  getPlaybackTranscodeJobs(): Promise<void>[];
};

function getTestApi(): PlaybackTranscodeTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.playbackTranscodeTestApi")
  ];
  if (!api) {
    throw new Error("playback transcode test API is unavailable");
  }
  return api as PlaybackTranscodeTestApi;
}

export async function waitForPlaybackTranscodeJobsForTest(mode: "next" | "all"): Promise<number> {
  const jobs = getTestApi().getPlaybackTranscodeJobs();
  if (jobs.length === 0) {
    throw new Error("No active playback transcode jobs");
  }
  await (mode === "next" ? Promise.race(jobs) : Promise.all(jobs));
  return jobs.length;
}

// Stop issuing requests and release every fixture gate before calling; this joins
// the existing jobs for cleanup and does not assert that conversion succeeded.
export async function settlePlaybackTranscodeJobsForTest(): Promise<void> {
  await Promise.allSettled(getTestApi().getPlaybackTranscodeJobs());
}
