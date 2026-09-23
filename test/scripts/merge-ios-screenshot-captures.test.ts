import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeIosScreenshotCaptures } from "../../scripts/merge-ios-screenshot-captures.mjs";

function writeShard(
  root: string,
  family: "iphone" | "ipad-13",
  part: 1 | 2,
  partCount: 1 | 2 = 2,
  runAttempt = 1,
) {
  const shard = path.join(root, `${family}-${part}`);
  mkdirSync(path.join(shard, "screenshots"), { recursive: true });
  mkdirSync(path.join(shard, "xcresults", `${family}-${part}.xcresult`), { recursive: true });
  const device = family === "iphone" ? "iPhone 17 Pro Max" : "iPad Pro 13-inch (M5)";
  const names =
    partCount === 1
      ? ["01-control-connected", "02-chat-connected", "03-agent-connected", "04-settings-connected"]
      : part === 1
        ? ["01-control-connected", "03-agent-connected"]
        : ["02-chat-connected", "04-settings-connected"];
  for (const name of names) {
    writeFileSync(path.join(shard, "screenshots", `${device}-${name}.png`), "png");
  }
  if (family === "ipad-13" && part === 1) {
    writeFileSync(
      path.join(shard, "screenshots", "Apple Watch Ultra 3 (49mm)-01-control-connected.png"),
      "png",
    );
  }
  writeFileSync(
    path.join(shard, "metadata.json"),
    JSON.stringify({
      deviceFamily: family,
      runAttempt,
      part,
      partCount,
      xcodeVersion: "Xcode 27.0 Build version 18A1",
      fastlaneVersion: "2.999.0",
      nodeVersion: "v24.1.0",
    }),
  );
  writeFileSync(
    path.join(shard, "capture-attempts.json"),
    JSON.stringify({ schemaVersion: 1, attempts: names.map((name) => ({ name })) }),
  );
}

describe("mergeIosScreenshotCaptures", () => {
  it.each(["iphone", "ipad-13"] as const)("merges complete %s partitions", (family) => {
    const root = mkdtempSync(path.join(tmpdir(), "ios-screenshot-merge-"));
    writeShard(root, family, 1);
    writeShard(root, family, 2);
    const result = mergeIosScreenshotCaptures({
      family,
      inputRoot: root,
      outputRoot: path.join(root, "merged"),
      runAttempt: 1,
    });
    expect(result).toEqual({
      attempts: 4,
      screenshots: family === "ipad-13" ? 5 : 4,
      xcresults: 2,
    });
    expect(
      JSON.parse(
        readFileSync(path.join(root, "merged", "xcresults", "capture-attempts.json"), "utf8"),
      ),
    ).toMatchObject({ schemaVersion: 1 });
    expect(() =>
      readFileSync(path.join(root, "merged", "capture-attempts.json"), "utf8"),
    ).toThrow();
  });

  it.each(["iphone", "ipad-13"] as const)(
    "accepts an unpartitioned historical %s capture",
    (family) => {
      const root = mkdtempSync(path.join(tmpdir(), "ios-screenshot-merge-"));
      writeShard(root, family, 1, 1);
      expect(
        mergeIosScreenshotCaptures({
          family,
          inputRoot: root,
          outputRoot: path.join(root, "merged"),
          runAttempt: 1,
        }),
      ).toEqual({
        attempts: 4,
        screenshots: family === "ipad-13" ? 5 : 4,
        xcresults: 1,
      });
    },
  );

  it("rejects duplicate capture parts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ios-screenshot-merge-"));
    writeShard(root, "iphone", 1);
    writeShard(root, "iphone", 2);
    const second = path.join(root, "iphone-2", "metadata.json");
    const metadata = JSON.parse(readFileSync(second, "utf8"));
    writeFileSync(second, JSON.stringify({ ...metadata, part: 1 }));
    expect(() =>
      mergeIosScreenshotCaptures({
        family: "iphone",
        inputRoot: root,
        outputRoot: path.join(root, "merged"),
        runAttempt: 1,
      }),
    ).toThrow("unique iphone parts 1 through 2");
  });

  it("rejects a capture from an earlier workflow attempt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ios-screenshot-merge-"));
    writeShard(root, "iphone", 1, 2, 1);
    writeShard(root, "iphone", 2, 2, 2);
    expect(() =>
      mergeIosScreenshotCaptures({
        family: "iphone",
        inputRoot: root,
        outputRoot: path.join(root, "merged"),
        runAttempt: 2,
      }),
    ).toThrow("run attempt 2");
  });
});
