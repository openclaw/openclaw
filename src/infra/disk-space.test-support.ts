import type fs from "node:fs";

export function createStatfsFixture(params: {
  bavail: number;
  bsize?: number;
  blocks?: number;
}): ReturnType<typeof fs.statfsSync> {
  return {
    type: 0,
    bsize: params.bsize ?? 1024,
    blocks: params.blocks ?? 2_000_000,
    bfree: params.bavail,
    bavail: params.bavail,
    files: 0,
    frsize: params.bsize ?? 1024,
    ffree: 0,
  };
}
