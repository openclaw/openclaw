import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const APPCAST_URL = new URL("../appcast.xml", import.meta.url);

function expectedSparkleVersion(shortVersion: string): string {
  const [year, month, day] = shortVersion.split(".");
  if (!year || !month || !day) {
    throw new Error(`unexpected short version: ${shortVersion}`);
  }
  return `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}0`;
}

describe("appcast.xml", () => {
  it("uses the expected Sparkle version for 2026.2.15", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const shortVersion = "2026.2.15";
    const items = Array.from(appcast.matchAll(/<item>[\s\S]*?<\/item>/g)).map((match) => match[0]);
    const matchingItem = items.find((item) =>
      item.includes(`<sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString>`),
    );

    expect(matchingItem).toBeDefined();
    const sparkleMatch = matchingItem?.match(/<sparkle:version>([^<]+)<\/sparkle:version>/);
    expect(sparkleMatch?.[1]).toBe(expectedSparkleVersion(shortVersion));
  });

  it("all versions use date-based sparkle:version format (YYYYMMDD0)", () => {
    const appcast = readFileSync(APPCAST_URL, "utf8");
    const items = Array.from(appcast.matchAll(/<item>[\s\S]*?<\/item>/g)).map((match) => match[0]);

    for (const item of items) {
      const shortMatch = item.match(
        /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/,
      );
      const sparkleMatch = item.match(/<sparkle:version>([^<]+)<\/sparkle:version>/);

      if (shortMatch && sparkleMatch) {
        const shortVersion = shortMatch[1];
        const sparkleVersion = sparkleMatch[1];
        const expected = expectedSparkleVersion(shortVersion);

        expect(
          sparkleVersion,
          `Version ${shortVersion} has incorrect sparkle:version (expected ${expected}, got ${sparkleVersion})`,
        ).toBe(expected);
      }
    }
  });
});
