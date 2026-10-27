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

function namespaceFixture(phase: "fresh-copy" | "dormant-finish" | "recapture") {
  const root = dirs.make("plugin-native-namespace-");
  const sourceDirectory = path.join(root, "source");
  fs.mkdirSync(sourceDirectory);
  const sourceFile = path.join(sourceDirectory, "LICENSE.md");
  fs.writeFileSync(sourceFile, originalBytes);
  // An exactly representable mtime lets the rewrite control restore it without rounding drift.
  fs.utimesSync(sourceFile, modifiedAt, modifiedAt);
  const fixture = {
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
  const previous = phase === "fresh-copy" ? undefined : fixture.capture("first");
  if (phase === "recapture") {
    finishPluginNativeNamespace(previous!);
  }
  const name = phase === "recapture" ? "second" : "first";
  return {
    ...fixture,
    previousFile: fixture.capturedFile("first"),
    capturedFile: fixture.capturedFile(name),
    observedFile: phase === "fresh-copy" ? sourceFile : fixture.capturedFile(name),
    finish() {
      const fact = phase === "dormant-finish" ? previous! : fixture.capture(name, previous);
      finishPluginNativeNamespace(fact);
      return fact;
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

it.each([
  { phase: "fresh-copy", change: "ctime" },
  { phase: "dormant-finish", change: "ctime" },
  { phase: "recapture", change: "ctime" },
  { phase: "fresh-copy", change: "bytes" },
  { phase: "recapture", change: "previous-bytes" },
  { phase: "fresh-copy", change: "mtime" },
  { phase: "dormant-finish", change: "mtime" },
  { phase: "recapture", change: "mtime" },
] as const)("admits only unchanged bytes during $phase ($change, #179923)", ({ phase, change }) => {
  const fixture = namespaceFixture(phase);
  let observed: (() => boolean) | undefined;
  if (change === "previous-bytes") {
    // A completed receipt must not bless edited retained bytes.
    fs.writeFileSync(fixture.previousFile, changedBytes);
  } else {
    observed = changeOnRead(fixture.observedFile, change);
  }
  if (change === "ctime") {
    const fact = fixture.finish();
    expect(fs.readFileSync(fixture.capturedFile)).toEqual(originalBytes);
    expect(fact.members["LICENSE.md"]).toMatchObject({
      sizeBytes: originalBytes.length,
      contentHash: createHash("sha256").update(originalBytes).digest("hex"),
    });
    // Accepted metadata must be recorded, or the next reuse invalidates itself.
    expect(pluginNativeNamespaceIsCurrent(fact, fixture.sourceDirectory)).toBe(true);
  } else {
    expect(() => fixture.finish()).toThrow(/Native plugin (?:directory|companion) changed/);
  }
  if (observed) {
    expect(observed()).toBe(true);
  }
  if (change === "bytes") {
    // The copy retained the old read despite the same-size/mtime source rewrite.
    expect(fs.readFileSync(fixture.capturedFile)).toEqual(originalBytes);
    expect(fs.readFileSync(fixture.sourceFile)).toEqual(changedBytes);
    expect(fs.statSync(fixture.sourceFile, { bigint: true })).toMatchObject({
      size: BigInt(originalBytes.length),
      mtimeNs: BigInt(modifiedAt.getTime()) * 1_000_000n,
    });
  }
});
