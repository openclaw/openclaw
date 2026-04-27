import { describe, expect, it } from "vitest";
import {
  LIVE_TEST_SHARDS,
  collectAllLiveTestFiles,
  selectLiveShardFiles,
} from "../../scripts/test-live-shard.mjs";

describe("scripts/test-live-shard", () => {
  it("partitions every native live test into exactly one release shard", () => {
    const allFiles = collectAllLiveTestFiles();
    const selected = LIVE_TEST_SHARDS.flatMap((shard) =>
      selectLiveShardFiles(shard, allFiles).map((file) => ({ file, shard })),
    );
    const selectedFiles = selected.map(({ file }) => file);

    expect(allFiles.length).toBeGreaterThan(0);
    expect(selectedFiles.toSorted()).toEqual(allFiles);
    expect(new Set(selectedFiles).size).toBe(selectedFiles.length);
  });

  it("keeps media-capable extension and test harness files in their own shards", () => {
    const allFiles = collectAllLiveTestFiles();

    expect(selectLiveShardFiles("native-live-test", allFiles)).toEqual(
      expect.arrayContaining([
        "test/image-generation.infer-cli.live.test.ts",
        "test/image-generation.runtime.live.test.ts",
      ]),
    );
    expect(selectLiveShardFiles("native-live-extensions-l-z", allFiles)).toEqual(
      expect.arrayContaining([
        "extensions/music-generation-providers.live.test.ts",
        "extensions/video-generation-providers.live.test.ts",
      ]),
    );
  });

  it("rejects unknown shard names", () => {
    expect(() => selectLiveShardFiles("native-live-missing")).toThrow(/Unknown live test shard/u);
  });
});
