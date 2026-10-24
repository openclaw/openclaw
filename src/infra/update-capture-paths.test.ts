import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertNotUpdateCapturePath } from "./update-capture-paths.js";

// These bytes are the producer contract, not an inferred JSON schema.
const markerName = ".openclaw-private-update-capture";
const markerContent = "openclaw-private-update-capture-v1\n";
const directoryLink = process.platform === "win32" ? "junction" : "dir";

let root: string;
let marker: string;
let source: string;
let stateDir: string;
const expectInvalidMarker = (file = source) =>
  expect(() => assertNotUpdateCapturePath(file, stateDir)).toThrow("Private update capture marker");
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-marker-"));
  marker = path.join(root, markerName);
  source = path.join(root, "raw.txt");
  stateDir = path.join(root, "unrelated-state");
  fs.writeFileSync(source, "synthetic retained bytes");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(["version", "oversized", "dangling symlink"])("rejects %s markers", (kind) => {
  if (kind === "dangling symlink") {
    fs.symlinkSync(path.join(root, "missing"), marker);
  } else {
    fs.writeFileSync(
      marker,
      kind === "version" ? "openclaw-private-update-capture-v2\n" : "x".repeat(4096),
    );
  }
  expectInvalidMarker();
  expect(fs.readFileSync(source, "utf8")).toBe("synthetic retained bytes");
});

it.skipIf(process.platform === "win32")("refuses a FIFO marker without opening it", () => {
  execFileSync("mkfifo", [marker]);
  const open = vi.spyOn(fs, "openSync");
  expectInvalidMarker();
  expect(open).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "refuses an unreadable marker",
  () => {
    fs.writeFileSync(marker, markerContent, { mode: 0o000 });
    expectInvalidMarker();
  },
);

it("does not let a valid child marker hide a malformed ancestor marker", () => {
  fs.writeFileSync(marker, "invalid");
  const child = path.join(root, "child");
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, markerName), markerContent);
  expectInvalidMarker(path.join(child, "raw.txt"));
});

it("refuses marker replacement during a bounded read even with identical bytes", () => {
  fs.writeFileSync(marker, markerContent);
  const original = fs.statSync(marker, { bigint: true });
  const read = fs.readSync.bind(fs);
  let replaced = false;
  vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const result = read(...args);
    const opened = fs.fstatSync(args[0], { bigint: true });
    if (!replaced && opened.dev === original.dev && opened.ino === original.ino) {
      replaced = true;
      fs.renameSync(marker, `${marker}.old`);
      fs.writeFileSync(marker, markerContent);
    }
    return result;
  });
  expectInvalidMarker();
  expect(replaced).toBe(true);
});
it.each([
  ["hop/../../hop/../raw.txt", "Private update captures are excluded"],
  ["private/raw.txt/", null],
])("resolves capture symlink target %s in filesystem order", (target, error) => {
  const privateDir = path.join(root, "private");
  fs.mkdirSync(path.join(privateDir, "child"), { recursive: true });
  fs.writeFileSync(path.join(privateDir, markerName), markerContent);
  fs.writeFileSync(path.join(privateDir, "raw.txt"), "private bytes");
  fs.symlinkSync(path.join(privateDir, "child"), path.join(root, "hop"), directoryLink);
  const alias = path.join(root, "alias");
  fs.symlinkSync(target, alias);
  const assertion = expect(() => assertNotUpdateCapturePath(alias, stateDir));
  if (error) {
    assertion.toThrow(error);
  } else {
    assertion.not.toThrow();
  }
});
