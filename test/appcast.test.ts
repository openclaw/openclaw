import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSparkleBuildFromVersion } from "../scripts/sparkle-build.ts";

const APPCAST_URL = new URL("../appcast.xml", import.meta.url);

describe("appcast.xml", () => {
  it("uses canonical sparkle build for the latest stable appcast entry", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const items = [...appcast.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1] ?? "");
    expect(items.length).toBeGreaterThan(0);

    const stableItem = items.find((item) => /<sparkle:version>\d+90<\/sparkle:version>/.test(item));
    expect(stableItem).toBeDefined();

    const shortVersion = stableItem?.match(
      /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/,
    )?.[1];
    const sparkleVersion = stableItem?.match(/<sparkle:version>([^<]+)<\/sparkle:version>/)?.[1];

    expect(shortVersion).toBeDefined();
    expect(sparkleVersion).toBeDefined();
    expect(sparkleVersion).toBe(String(canonicalSparkleBuildFromVersion(shortVersion!)));
  });
});
