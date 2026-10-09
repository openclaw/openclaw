import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const proof = readFileSync("scripts/e2e/lib/artifact-permissions/runtime-proof.mjs", "utf8");
const start = proof.indexOf("  const original = readFileSync(");
const end = proof.indexOf("  let compressedAssets = 0;", start);
if (start < 0 || end < start) {
  throw new Error("Runtime proof omitted its core asset membership checks");
}
const membership = proof.slice(start, end);
const baseline =
  '<script src="/assets/base.js"></script><link rel="stylesheet" href="/assets/base.css">';

function checkMembership(original: string, served: string) {
  // Exercise the shipped proof without booting a Gateway or duplicating its parser.
  runInNewContext(membership, {
    assert,
    URL,
    root: "/app",
    readFileSync: () => original,
    document: { body: Buffer.from(served) },
  });
}

describe("runtime proof core asset membership", () => {
  it.each([
    '<SCRIPT SRC="/assets/Required.js"></SCRIPT>',
    '<ScRiPt sRc="/assets/Required.js"></ScRiPt>',
    '<LINK REL="STYLESHEET" HREF="/assets/Required.css">',
    '<LiNk rEl="StyleSheet" hReF="/assets/Required.css">',
  ])("rejects an omitted asset declared with case-insensitive HTML syntax: %s", (tag) => {
    expect(() => checkMembership(baseline + tag, baseline)).toThrow(
      "Served document omitted required asset",
    );
    expect(() => checkMembership(baseline + tag, baseline + tag)).not.toThrow();
    const servedTag = tag
      .replace(/<\/?(?:script|link)\b/giu, (name) => name.toLowerCase())
      .replace(/\b(?:src|href|rel)=/giu, (name) => name.toLowerCase());
    expect(() => checkMembership(baseline + tag, baseline + servedTag)).not.toThrow();
  });

  it("preserves case-sensitive asset URL paths", () => {
    const original = baseline + '<SCRIPT SRC="/assets/Required.js"></SCRIPT>';
    const served = baseline + '<script src="/assets/required.js"></script>';
    expect(() => checkMembership(original, served)).toThrow(
      "Served document omitted required asset /assets/Required.js",
    );
  });
});
