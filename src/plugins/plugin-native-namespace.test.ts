import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  capturePluginNativeNamespace,
  finishPluginNativeNamespace,
  pluginNativeNamespaceIsCurrent,
} from "./plugin-native-namespace.js";
import type { PluginNativeNamespaceFact } from "./plugin-source-admission.types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const originalBytes = Buffer.from("unchanged native companion\n");
const changedBytes = Buffer.from("different native companion\n");
const modifiedAt = new Date("2020-01-01T00:00:00Z");

function namespaceFixture() {
  const root = dirs.make("plugin-native-namespace-");
  const sourceDirectory = path.join(root, "source");
  fs.mkdirSync(sourceDirectory);
  const sourceFile = path.join(sourceDirectory, "LICENSE.md");
  fs.writeFileSync(sourceFile, originalBytes);
  // An exactly representable mtime lets the rewrite control restore it without rounding drift.
  fs.utimesSync(sourceFile, modifiedAt, modifiedAt);
  return {
    sourceDirectory,
    sourceFile,
    capturedFile: (name: string) => path.join(root, name, "content", "LICENSE.md"),
    capture(name: string, previous?: PluginNativeNamespaceFact) {
      const capturedRoot = path.join(root, name);
      fs.mkdirSync(capturedRoot);
      return capturePluginNativeNamespace({
        sourceDirectory,
        boundary: sourceDirectory,
        capturedRoot,
        managed: false,
        copyOnly: true,
        previous,
      }).fact;
    },
  };
}

// Model an Endpoint-DLP stamp only after a real descriptor read, not before admission.
// Identify the inode rather than the pathname so the stimulus also follows retained links.
function changeOnRead(filename: string, change: "ctime" | "mtime" | "bytes") {
  const { readSync, statSync } = fs;
  let changed: fs.BigIntStats | undefined;
  vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const length = Reflect.apply(readSync, fs, args);
    const named = statSync(filename, { bigint: true, throwIfNoEntry: false });
    const opened = fs.fstatSync(args[0], { bigint: true });
    if (
      !changed &&
      named?.dev === opened.dev &&
      named?.ino === opened.ino &&
      // The byte rewrite must follow the copy read, not the four-byte native-magic probe.
      length >= (change === "bytes" ? originalBytes.length : 1)
    ) {
      changed = opened;
      if (change === "bytes") {
        fs.writeFileSync(filename, changedBytes);
        fs.utimesSync(filename, modifiedAt, modifiedAt);
      }
    }
    return length;
  });
  vi.spyOn(fs, "statSync").mockImplementation((file, options) => {
    if (typeof options !== "object" || !options?.bigint) {
      return statSync(file, options);
    }
    const stat =
      options.throwIfNoEntry === false
        ? statSync(file, { bigint: true, throwIfNoEntry: false })
        : statSync(file, { bigint: true });
    if (changed && stat?.dev === changed.dev && stat?.ino === changed.ino) {
      stat.ctimeNs += 1_000_000_000n;
      if (change === "mtime") {
        stat.mtimeNs += 1_000_000_000n;
      }
    }
    return stat;
  });
  return () => changed !== undefined;
}

it.each(["fresh-copy", "dormant-finish", "recapture"] as const)(
  "admits unchanged companion bytes after a first-read ctime stamp during %s (#179923)",
  (phase) => {
    const fixture = namespaceFixture();
    const previous = phase === "fresh-copy" ? undefined : fixture.capture("first");
    if (phase === "recapture") {
      finishPluginNativeNamespace(previous!);
    }
    const name = phase === "recapture" ? "second" : "first";
    const capturedFile = fixture.capturedFile(name);
    const observed = changeOnRead(
      phase === "fresh-copy" ? fixture.sourceFile : capturedFile,
      "ctime",
    );

    const fact = phase === "dormant-finish" ? previous! : fixture.capture(name, previous);
    finishPluginNativeNamespace(fact);

    expect(observed()).toBe(true);
    expect(fs.readFileSync(capturedFile)).toEqual(originalBytes);
    expect(fact.members["LICENSE.md"]).toMatchObject({
      sizeBytes: originalBytes.length,
      contentHash: createHash("sha256").update(originalBytes).digest("hex"),
    });
    // Accepted read-side metadata must be recorded, or the very next reuse invalidates itself.
    expect(pluginNativeNamespaceIsCurrent(fact, fixture.sourceDirectory)).toBe(true);
  },
);

it.each([
  { phase: "fresh-copy", change: "bytes" },
  { phase: "recapture", change: "previous-bytes" },
  { phase: "fresh-copy", change: "mtime" },
  { phase: "dormant-finish", change: "mtime" },
  { phase: "recapture", change: "mtime" },
] as const)(
  "rejects changed companion bytes or non-ctime metadata during $phase ($change)",
  ({ phase, change }) => {
    const fixture = namespaceFixture();
    const previous = phase === "fresh-copy" ? undefined : fixture.capture("first");
    if (phase === "recapture") {
      finishPluginNativeNamespace(previous!);
    }
    const name = phase === "recapture" ? "second" : "first";
    let observed: (() => boolean) | undefined;
    if (change === "previous-bytes") {
      // A real completed receipt supplies the digest; recapture must not bless edited retained bytes.
      fs.writeFileSync(fixture.capturedFile("first"), changedBytes);
    } else {
      observed = changeOnRead(
        phase === "fresh-copy" ? fixture.sourceFile : fixture.capturedFile(name),
        change,
      );
    }

    expect(() => {
      const fact = phase === "dormant-finish" ? previous! : fixture.capture(name, previous);
      finishPluginNativeNamespace(fact);
    }).toThrow(/Native plugin (?:directory|companion) changed/);

    if (observed) {
      expect(observed()).toBe(true);
    }
    if (change === "bytes") {
      // The copy retained the old read while the unmanaged source changed with size/mtime intact.
      expect(fs.readFileSync(fixture.capturedFile(name))).toEqual(originalBytes);
      expect(fs.readFileSync(fixture.sourceFile)).toEqual(changedBytes);
      expect(fs.statSync(fixture.sourceFile, { bigint: true })).toMatchObject({
        size: BigInt(originalBytes.length),
        mtimeNs: BigInt(modifiedAt.getTime()) * 1_000_000n,
      });
    }
  },
);
