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
  const appcast = readFileSync(APPCAST_URL, "utf8");
  const items = Array.from(appcast.matchAll(/<item>[\s\S]*?<\/item>/g)).map((match) => match[0]);

  it.each(items)("uses the expected sparkle:version for each item", (item) => {
    const shortMatch = item.match(
      /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/,
    );
    expect(shortMatch).toBeDefined();
    const shortVersion = shortMatch![1];

    const versionMatch = item.match(/<sparkle:version>([^<]+)<\/sparkle:version>/);
    expect(versionMatch).toBeDefined();
    expect(versionMatch![1]).toBe(expectedSparkleVersion(shortVersion));
  });
});
