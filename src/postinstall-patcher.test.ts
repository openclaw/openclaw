import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyPatchSet } from "../scripts/postinstall.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-patch-"));
}

describe("postinstall patcher", () => {
  it("applies a simple patch", () => {
    const dir = makeTempDir();
    const target = path.join(dir, "lib");
    fs.mkdirSync(target);

    const filePath = path.join(target, "main.js");
    const original = `${[
      "var QRCode = require('./../vendor/QRCode'),",
      "    QRErrorCorrectLevel = require('./../vendor/QRCode/QRErrorCorrectLevel'),",
      '    black = "\\033[40m  \\033[0m",',
      '    white = "\\033[47m  \\033[0m",',
      "    toCell = function (isBlack) {",
    ].join("\n")}\n`;
    fs.writeFileSync(filePath, original, "utf-8");

    const patchText = `diff --git a/lib/main.js b/lib/main.js
index 0000000..1111111 100644
--- a/lib/main.js
+++ b/lib/main.js
@@ -1,5 +1,5 @@
-var QRCode = require('./../vendor/QRCode'),
-    QRErrorCorrectLevel = require('./../vendor/QRCode/QRErrorCorrectLevel'),
+var QRCode = require('./../vendor/QRCode/index.js'),
+    QRErrorCorrectLevel = require('./../vendor/QRCode/QRErrorCorrectLevel.js'),
     black = "\\033[40m  \\033[0m",
     white = "\\033[47m  \\033[0m",
     toCell = function (isBlack) {
`;

    applyPatchSet({ patchText, targetDir: dir });

    const updated = fs.readFileSync(filePath, "utf-8");
    expect(updated).toBe(
      `${[
        "var QRCode = require('./../vendor/QRCode/index.js'),",
        "    QRErrorCorrectLevel = require('./../vendor/QRCode/QRErrorCorrectLevel.js'),",
        '    black = "\\033[40m  \\033[0m",',
        '    white = "\\033[47m  \\033[0m",',
        "    toCell = function (isBlack) {",
      ].join("\n")}\n`,
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles multiple hunks with offsets", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "file.txt");
    fs.writeFileSync(
      filePath,
      `${["alpha", "beta", "gamma", "delta", "epsilon"].join("\n")}\n`,
      "utf-8",
    );

    const patchText = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 alpha
 beta
+beta2
 gamma
@@ -3,3 +4,4 @@
 gamma
-delta
+DELTA
 epsilon
+zeta
`;

    applyPatchSet({ patchText, targetDir: dir });

    const updated = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    expect(updated).toEqual([
      "alpha",
      "beta",
      "beta2",
      "gamma",
      "DELTA",
      "epsilon",
      "zeta",
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws on context mismatch", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "file.txt");
    fs.writeFileSync(filePath, "hello\nworld\n", "utf-8");

    const patchText = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
-hola
+hi
 world
`;

    expect(() => applyPatchSet({ patchText, targetDir: dir })).toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
