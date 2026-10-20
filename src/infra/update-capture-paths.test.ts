import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotUpdateCapturePath } from "./update-capture-paths.js";

// These bytes are the producer contract, not an inferred JSON schema.
const markerName = ".openclaw-private-update-capture";
const markerContent = "openclaw-private-update-capture-v1\n";

describe("private capture marker admission", () => {
  let root: string;
  let marker: string;
  let source: string;
  let stateDir: string;
  const expectInvalidMarker = (file = source) =>
    expect(() => assertNotUpdateCapturePath(file, stateDir)).toThrow(
      "Private update capture marker",
    );
  function privateDirectory(child = "") {
    const directory = path.join(root, "private");
    fs.mkdirSync(path.join(directory, child), { recursive: true });
    fs.writeFileSync(path.join(directory, markerName), markerContent);
    fs.writeFileSync(path.join(directory, "raw.txt"), "private bytes");
    return directory;
  }
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

  it.each(["version", "oversized", "dangling symlink"])(
    "refuses a present %s marker without treating the artifact as ordinary data",
    (kind) => {
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
    },
  );

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
      try {
        expectInvalidMarker();
      } finally {
        fs.chmodSync(marker, 0o600);
      }
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
    vi.spyOn(fs, "readSync").mockImplementation(
      (
        descriptor: number,
        buffer: NodeJS.ArrayBufferView,
        offsetOrOptions: number | fs.ReadOptions = {},
        length?: number,
        position?: fs.ReadPosition | null,
      ) => {
        const options =
          typeof offsetOrOptions === "number"
            ? { offset: offsetOrOptions, length, position }
            : offsetOrOptions;
        const result = read(descriptor, buffer, options);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!replaced && opened.dev === original.dev && opened.ino === original.ino) {
          replaced = true;
          fs.renameSync(marker, `${marker}.old`);
          fs.writeFileSync(marker, markerContent);
        }
        return result;
      },
    );
    expectInvalidMarker();
    expect(replaced).toBe(true);
  });
  it("resolves repeated symlink target components in filesystem order", () => {
    const privateDir = privateDirectory("child");
    fs.symlinkSync(
      path.join(privateDir, "child"),
      path.join(root, "hop"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const alias = path.join(root, "alias");
    fs.symlinkSync("hop/../../hop/../raw.txt", alias);
    expect(() => assertNotUpdateCapturePath(alias, stateDir)).toThrow(
      "Private update captures are excluded",
    );
  });
  it("assertNotUpdateCapturePath preserves an unresolved target with a trailing directory separator", () => {
    privateDirectory();
    const alias = path.join(root, "alias");
    fs.symlinkSync("private/raw.txt/", alias);
    expect(() => assertNotUpdateCapturePath(alias, stateDir)).not.toThrow();
  });
});
