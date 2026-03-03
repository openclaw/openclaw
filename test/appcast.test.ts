import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSparkleBuildFromVersion } from "../scripts/sparkle-build.ts";

const APPCAST_URL = new URL("../appcast.xml", import.meta.url);

describe("appcast.xml", () => {
  it("uses the expected Sparkle version for 2026.3.1", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const shortVersion = "2026.3.1";
    const items = Array.from(appcast.matchAll(/<item>[\s\S]*?<\/item>/g)).map((match) => match[0]);
    const matchingItem = items.find((item) =>
      item.includes(`<sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString>`),
    );

    expect(matchingItem).toBeDefined();
    const sparkleMatch = matchingItem?.match(/<sparkle:version>([^<]+)<\/sparkle:version>/);
    expect(sparkleMatch?.[1]).toBe(String(canonicalSparkleBuildFromVersion(shortVersion)));
  });
});
