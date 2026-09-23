import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import {
  nativeVisualProofPNG,
  nativeVisualProofPixelCheck,
  nativeVisualProofTrailingPayload,
} from "../fixtures/native-visual-proof.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repo = path.resolve(import.meta.dirname, "../..");
const temps = useAutoCleanupTempDirTracker(afterEach);
const png = Buffer.from(nativeVisualProofPNG, "base64");
const appended = Buffer.concat([
  png,
  Buffer.from(nativeVisualProofTrailingPayload),
  png.subarray(-12),
]);
const names = ["before-inspection", "after-inspection", "after-agent-change"].map(
  (name) => `native-action-${name}.png`,
);
const workflow = parse(readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8"));
const exportStep = Object.values(workflow.jobs)
  .flatMap((job) => (job as { steps: Array<{ name?: string; run?: string }> }).steps ?? [])
  .find((step) => step.name === "Export native action visual proof");

describe("native visual proof export", () => {
  it("routes shared image proof through both Apple lanes and the existing Darwin test command", () => {
    for (const changedPath of [
      "scripts/validate-native-visual-proof.swift",
      "test/scripts/native-visual-proof.test.ts",
      "test/fixtures/native-visual-proof.ts",
    ]) {
      expect(detectChangedScope([changedPath])).toMatchObject({
        runNode: true,
        runMacos: true,
        runMacosNode: true,
        runIosBuild: true,
      });
    }
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
    expect(pkg.scripts["test:macos:ci:3"].split(" ")).toContain(
      "test/scripts/native-visual-proof.test.ts",
    );
  });
  function exportFixture(decoderExit: number | "real") {
    const root = temps.make("native-visual-export-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const calls = path.join(root, "decoder-calls.json");
    const output = path.join(root, "apps/ios/build/NativeActionVisualProof");
    mkdirSync(path.dirname(output), { recursive: true });
    const testID = "NativeActionVisualProofTests/testInspectionRetiresWhenSelectedAgentChanges()";
    const testURL = "test://synthetic-native-visual-case";
    writeFileSync(
      path.join(bin, "xcrun"),
      `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const names = ${JSON.stringify(names)};
if (args[0] === 'xcresulttool' && args[1] === 'get') {
  console.log(JSON.stringify({testNodes: [{nodeType: 'Test Case', nodeIdentifier: ${JSON.stringify(testID)},
    nodeIdentifierURL: ${JSON.stringify(testURL)}, result: 'Passed'}]}));
} else if (args[0] === 'xcresulttool' && args[1] === 'export') {
  assert.equal(args[args.indexOf('--test-id') + 1], ${JSON.stringify(testURL)});
  const output = args[args.indexOf('--output-path') + 1];
  const attachments = names.map((name, index) => {
    const exportedFileName = index + '.png';
    fs.writeFileSync(path.join(output, exportedFileName), Buffer.from(${JSON.stringify(appended.toString("base64"))}, 'base64'));
    return {suggestedHumanReadableName: name, exportedFileName, isAssociatedWithFailure: false};
  });
  fs.writeFileSync(path.join(output, 'private.txt'), 'private fixture state');
  attachments.push({suggestedHumanReadableName: 'private.txt', exportedFileName: 'private.txt', isAssociatedWithFailure: false});
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify([{testIdentifierURL: ${JSON.stringify(testURL)}, attachments}]));
} else {
  assert.deepEqual(args.slice(0, 4), ['--sdk', 'macosx', 'swift', 'scripts/validate-native-visual-proof.swift']);
  assert.equal(args.length, 8);
  assert.deepEqual(fs.readdirSync(${JSON.stringify(output)}), []);
  for (const file of args.slice(5)) assert.ok(fs.statSync(file).isFile());
  fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(args));
  if (${JSON.stringify(decoderExit)} === 'real') {
    args[3] = ${JSON.stringify(path.join(repo, "scripts/validate-native-visual-proof.swift"))};
    const result = require('node:child_process').spawnSync('/usr/bin/xcrun', args, {stdio: 'inherit'});
    process.exit(result.status ?? 1);
  }
  fs.mkdirSync(args[4], {mode: 0o700});
  // Different from raw attachments: the caller must publish encoded output.
  for (const file of args.slice(5, ${decoderExit === 23 ? 6 : 8})) {
    fs.writeFileSync(path.join(args[4], path.basename(file)), Buffer.from(${JSON.stringify(nativeVisualProofPNG)}, 'base64'));
  }
  process.exit(${JSON.stringify(decoderExit)});
}
`,
      { mode: 0o755 },
    );
    const result = spawnSync("/bin/bash", ["-c", exportStep!.run!], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        PROOF_SOURCE_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    expect(result.error).toBeUndefined();
    expect(existsSync(calls)).toBe(true);
    return { result, root, output, testID };
  }

  it.each([0, 23])("publishes only after the managed encoder succeeds (exit %s)", (decoderExit) => {
    const { result, output, testID } = exportFixture(decoderExit);
    if (decoderExit !== 0) {
      expect(result.status).not.toBe(0);
      expect(readdirSync(output)).toEqual([]);
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(output).toSorted()).toEqual([...names, "manifest.json"].toSorted());
    const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
    expect(manifest).toEqual({
      sourceSha: "a".repeat(40),
      runId: "12345",
      attempt: "1",
      test: testID,
      result: "Passed",
      comparison: "same-candidate action states",
      images: [...names].toSorted().map((name) => ({
        name,
        bytes: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        width: 200,
        height: 200,
      })),
    });
    for (const name of names) {
      expect(readFileSync(path.join(output, name))).toEqual(png);
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "publishes lossless encoded pixels without trailing source payload",
    () => {
      const { result, root, output } = exportFixture("real");
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
      for (const image of manifest.images) {
        const encoded = readFileSync(path.join(output, image.name));
        expect(encoded.includes(Buffer.from(nativeVisualProofTrailingPayload))).toBe(false);
        expect(encoded).not.toEqual(appended);
        expect(image.bytes).toBe(encoded.length);
        expect(image.sha256).toBe(createHash("sha256").update(encoded).digest("hex"));
      }
      expect(readFileSync(path.join(root, "native-action-visual-attachments", "0.png"))).toEqual(
        appended,
      );
      const pixels = spawnSync(
        "/usr/bin/xcrun",
        [
          "--sdk",
          "macosx",
          "swift",
          "-e",
          nativeVisualProofPixelCheck,
          ...names.map((name) => path.join(output, name)),
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(pixels.error).toBeUndefined();
      expect(pixels.status, pixels.stderr).toBe(0);
    },
  );

  it.skipIf(process.platform !== "darwin").each(["header-only", "truncated"])(
    "rejects incomplete %s input after privately preparing an earlier image",
    (kind) => {
      const root = temps.make("native-visual-decode-");
      const valid = path.join(root, "valid.png");
      const file = path.join(root, "image.png");
      const output = path.join(root, "normalized");
      writeFileSync(valid, png);
      writeFileSync(file, kind === "header-only" ? png.subarray(0, 33) : png.subarray(0, -16));
      const result = spawnSync(
        "/usr/bin/xcrun",
        [
          "--sdk",
          "macosx",
          "swift",
          path.join(repo, "scripts/validate-native-visual-proof.swift"),
          output,
          valid,
          file,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(readdirSync(output)).toEqual(["valid.png"]);
    },
  );
});
