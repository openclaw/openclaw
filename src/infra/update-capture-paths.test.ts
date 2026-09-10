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

  it.each(["empty", "version", "oversized", "directory", "symlink", "dangling symlink"])(
    "refuses a present %s marker without treating the artifact as ordinary data",
    (kind) => {
      if (kind === "directory") {
        fs.mkdirSync(marker);
      } else if (kind.includes("symlink")) {
        fs.symlinkSync(kind === "symlink" ? source : path.join(root, "missing"), marker);
      } else {
        fs.writeFileSync(
          marker,
          kind === "empty"
            ? ""
            : kind === "version"
              ? "openclaw-private-update-capture-v2\n"
              : "x".repeat(4096),
        );
      }
      expect(() => assertNotUpdateCapturePath(source, stateDir)).toThrow(
        "Private update capture marker",
      );
      expect(fs.readFileSync(source, "utf8")).toBe("synthetic retained bytes");
    },
  );

  it.skipIf(process.platform === "win32")("refuses a FIFO marker without opening it", () => {
    execFileSync("mkfifo", [marker]);
    const open = vi.spyOn(fs, "openSync");
    expect(() => assertNotUpdateCapturePath(source, stateDir)).toThrow(
      "Private update capture marker",
    );
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses an unreadable marker",
    () => {
      fs.writeFileSync(marker, markerContent, { mode: 0o000 });
      try {
        expect(() => assertNotUpdateCapturePath(source, stateDir)).toThrow(
          "Private update capture marker",
        );
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
    expect(() => assertNotUpdateCapturePath(path.join(child, "raw.txt"), stateDir)).toThrow(
      "Private update capture marker",
    );
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
    expect(() => assertNotUpdateCapturePath(source, stateDir)).toThrow(
      "Private update capture marker",
    );
    expect(replaced).toBe(true);
  });
});
