import { describe, expect, it } from "vitest";
import { collectBundledChannelConfigMetadata } from "../../scripts/generate-bundled-channel-config-metadata.ts";
import { BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.js";

describe("bundled channel config metadata", () => {
  it("matches the generated metadata snapshot", async () => {
    expect(BUNDLED_CHANNEL_CONFIG_METADATA).toEqual(
      await collectBundledChannelConfigMetadata({ repoRoot: process.cwd() }),
    );
  });
});
