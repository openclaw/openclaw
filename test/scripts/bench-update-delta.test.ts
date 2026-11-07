import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/bench-update-delta.mjs");

function fixture() {
  const root = tempDirs.make("update-delta-benchmark-");
  const base = path.join(root, "base.zip");
  const target = path.join(root, "target.zip");
  const output = path.join(root, "output");
  writeFileSync(base, "previous archive");
  writeFileSync(target, "target archive");
  // Fixed external-I/O fixture, not a codec implementation or compression proof.
  writeFileSync(
    path.join(root, "zstd"),
    [
      "#!" + process.execPath,
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("zstd test fixture"); process.exit(0); }',
      'const outIndex = args.indexOf("-o");',
      'if (args.includes("--decompress") && process.env.CORRUPT_RECONSTRUCTION === "1") {',
      '  fs.writeFileSync(args[outIndex + 1], "corrupt reconstruction");',
      "} else {",
      "  fs.copyFileSync(args[outIndex - 1], args[outIndex + 1]);",
      "}",
    ].join("\n"),
    { mode: 0o755 },
  );
  const run = (corrupt = false) =>
    spawnSync(process.execPath, [script, base, target, output], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: root + path.delimiter + process.env.PATH,
        CORRUPT_RECONSTRUCTION: corrupt ? "1" : "0",
      },
    });
  return { base, target, output, run };
}

it("prints usage without creating output when arguments are missing", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage:");
});

it.skipIf(process.platform === "win32")(
  "records verified bytes without claiming signature or installer proof",
  () => {
    const { base, target, output, run } = fixture();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(path.join(output, "report.json"), "utf8"));
    const targetBytes = readFileSync(target);
    expect(readFileSync(path.join(output, "reconstructed.archive"))).toEqual(targetBytes);
    expect(report.base.bytes).toBe(readFileSync(base).byteLength);
    expect(report.target).toEqual({
      name: "target.zip",
      bytes: targetBytes.byteLength,
      sha256: createHash("sha256").update(targetBytes).digest("hex"),
    });
    expect(report.patch.bytes).toBe(targetBytes.byteLength);
    expect(report.reconstructed.sha256).toBe(report.target.sha256);
    expect(report.transferFraction).toBe(1);
    expect(report.reconstructionVerified).toBe(true);
    expect(report.signatureVerified).toBe(false);
    expect(report.peakMemoryBytes).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual(report);
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a successful report when reconstruction differs",
  () => {
    const { output, run } = fixture();
    const result = run(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Reconstruction SHA-256 does not match");
    expect(existsSync(path.join(output, "report.json"))).toBe(false);
  },
);

it.skipIf(process.platform === "win32")("preserves an existing output directory", () => {
  const { output, run } = fixture();
  mkdirSync(output);
  const reportPath = path.join(output, "report.json");
  writeFileSync(reportPath, "previous result");
  const result = run();
  expect(result.status).toBe(1);
  expect(readFileSync(reportPath, "utf8")).toBe("previous result");
  expect(existsSync(path.join(output, "archive.patch.zst"))).toBe(false);
});
