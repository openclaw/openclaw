import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { probeTreeClone, readCloneFileMetadata } from "@openclaw/fs-safe/copy";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

const temp = useAutoCleanupTempDirTracker(afterEach);
const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const artifact of artifacts.splice(0)) {
    artifact.dispose();
  }
});

function fixture(bytes: Buffer, basename = "fixture.bin") {
  const root = fs.realpathSync(temp.make("plugin-streaming-capture-"));
  const source = path.join(root, "source");
  const captures = path.join(root, "captures");
  fs.mkdirSync(source);
  fs.mkdirSync(captures);
  const filename = path.join(source, basename);
  fs.writeFileSync(filename, bytes, { mode: 0o755 });
  return {
    filename,
    capture(entry?: string) {
      const artifact = withPluginSourceCaptureDirectory(captures, () =>
        capturePluginGenerationArtifact(source, entry, (run) => run()),
      );
      artifacts.push(artifact);
      return artifact;
    },
  };
}

it.skipIf(process.platform !== "darwin")(
  "clones ordinary source files and their captured aliases on APFS",
  async ({ skip }) => {
    const bytes = Buffer.alloc(128 * 1024 + 1, "Z");
    const source = fixture(bytes, "fixture.dat");
    if (probeTreeClone(path.dirname(source.filename)) !== "apfs") {
      skip();
      return;
    }
    const alias = path.join(path.dirname(source.filename), "alias.dat");
    fs.symlinkSync("fixture.dat", alias);
    const artifact = source.capture();
    const captured = [artifact.resolve(alias), artifact.resolve(source.filename)];
    const [original, ...copies] = await readCloneFileMetadata([source.filename, ...captured]);
    expect(original?.cloneId).toBeGreaterThan(0n);
    for (const copy of copies) {
      expect(copy?.dev).toBe(original?.dev);
      expect(copy?.ino).not.toBe(original?.ino);
      expect(copy?.cloneId).toBe(original?.cloneId);
    }
    expect(copies[0]?.ino).not.toBe(copies[1]?.ino);
    fs.writeFileSync(captured[0]!, "changed capture");
    expect(fs.readFileSync(source.filename)).toEqual(bytes);
    expect(fs.readFileSync(captured[1]!)).toEqual(bytes);
  },
);

it("captures and verifies a native artifact without whole-file Buffer reads", () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, "Z");
  const source = fixture(bytes);
  const readFileSync = fs.readFileSync;
  const readSync = fs.readSync;
  let wholeFileReads = 0;
  let streamedBytes = 0;
  let largestBuffer = 0;
  const chunks = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const length = Reflect.apply(readSync, fs, args);
    if (fs.fstatSync(args[0]).size === bytes.length) {
      streamedBytes += length;
      if (Buffer.isBuffer(args[1])) {
        largestBuffer = Math.max(largestBuffer, args[1].byteLength);
      }
    }
    return length;
  });
  const reads = vi.spyOn(fs, "readFileSync").mockImplementation((filename, options) => {
    const result = readFileSync(filename, options);
    if (Buffer.isBuffer(result) && result.length >= bytes.length) {
      wholeFileReads += 1;
    }
    return result;
  });
  const artifact = source.capture();
  artifact.assertSourceCurrent();
  reads.mockRestore();
  chunks.mockRestore();

  expect(wholeFileReads).toBe(0);
  expect(largestBuffer).toBeLessThanOrEqual(1024 * 1024);
  // One capture digest and two fresh checks; portable descriptor copies add one transfer.
  const passes = process.platform === "linux" || process.platform === "darwin" ? 3 : 4;
  expect(streamedBytes).toBeLessThanOrEqual(bytes.length * passes);
  // SHA-256 of the existing package/directory/file receipt framing and this fixed payload.
  expect(artifact.sourceDigest).toBe(
    "390ebb32ae31f0b3ece04de41d05633762bff6932973d5d02ae284bf78e23d30",
  );
  const captured = artifact.resolve(source.filename);
  expect(fs.readFileSync(captured).equals(bytes)).toBe(true);
  if (process.platform !== "win32") {
    expect(fs.statSync(captured).mode & 0o777).toBe(0o700);
  }
  fs.writeFileSync(source.filename, "replaced");
  expect(fs.readFileSync(captured).equals(bytes)).toBe(true);
  fs.unlinkSync(source.filename);
  expect(fs.readFileSync(artifact.resolve(source.filename)).equals(bytes)).toBe(true);
});

it.each(["unchanged metadata", "growing source"])("rejects edits with %s", (kind) => {
  const source = fixture(Buffer.from("before"), "fixture.js");
  const before = fs.statSync(source.filename, { bigint: true });
  const artifact = source.capture();
  let reads = 0;
  if (kind === "unchanged metadata") {
    const statSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((filename, options) => {
      const stat = statSync(filename, options);
      if (filename === source.filename && stat && "mtimeNs" in stat) {
        stat.mtimeNs = before.mtimeNs;
        stat.ctimeNs = before.ctimeNs;
      }
      return stat;
    });
    expect(artifact.assertSourceCurrent).not.toThrow();
    fs.writeFileSync(source.filename, "edited");
  } else {
    const readSync = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const length = Reflect.apply(readSync, fs, args);
      const stat = fs.fstatSync(args[0], { bigint: true });
      if (stat.dev === before.dev && stat.ino === before.ino) {
        if (++reads > 8) {
          throw new Error("Verification did not bound a growing source");
        }
        fs.appendFileSync(source.filename, "growth");
      }
      return length;
    });
  }
  expect(artifact.assertSourceCurrent).toThrow(
    "Plugin source changed while preparing its reload; retry after the edit finishes.",
  );
  expect(reads).toBeLessThanOrEqual(2);
  expect(fs.readFileSync(artifact.resolve(source.filename), "utf8")).toBe("before");
});

it.each(["cold", "warm", "lazy"] as const)(
  "rejects a copied destination replaced before receipt admission (%s)",
  (phase) => {
    const source = fixture(Buffer.from("captured"), "fixture.js");
    fs.writeFileSync(path.join(path.dirname(source.filename), "native.bin"), "native");
    const entry = path.join(path.dirname(source.filename), "entry.js");
    fs.writeFileSync(entry, "export const ready = true;");
    if (phase === "warm") {
      source.capture();
    }
    const lazy = phase === "lazy" ? source.capture(entry) : undefined;
    const copyRootFileSync = fsSafeAdvanced.copyRootFileSync;
    let replaced = false;
    vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
      const copied = copyRootFileSync(options);
      if (options.source.absolutePath !== source.filename) {
        return copied;
      }
      const close = () => {
        copied.close();
        if (!replaced) {
          replaced = true;
          fs.renameSync(copied.path, `${copied.path}.original`);
          fs.writeFileSync(copied.path, "replaced");
        }
      };
      return { ...copied, close, [Symbol.dispose]: close };
    });

    const capture = () => (lazy ? lazy.captureResolvedModule(source.filename) : source.capture());
    expect(capture).toThrow("Plugin source changed while preparing its reload");
    if (lazy) {
      // A failed acquisition must not make the substituted pathname reusable.
      expect(capture).toThrow("Plugin source changed while preparing its reload");
      for (const specifier of [pathToFileURL(source.filename).href, "./fixture.js"]) {
        expect(() =>
          lazy.captureModule(lazy.resolve(entry), specifier, ["node", "import"]),
        ).toThrow("Plugin source changed while preparing its reload");
      }
      expect(lazy.captureRecoverySource).toThrow(
        "Plugin source changed while preparing its reload",
      );
    }
    expect(replaced).toBe(true);
    expect(fs.readFileSync(source.filename, "utf8")).toBe("captured");
  },
);

it("refuses a source swapped after OpenClaw pins it without leaving a capture", () => {
  const source = fixture(Buffer.from("pinned source"), "fixture.js");
  const admitted = fs.statSync(source.filename, { bigint: true });
  const copyRootFileSync = fsSafeAdvanced.copyRootFileSync;
  let target: string | undefined;
  let refused: unknown;
  vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
    if (options.source.absolutePath !== source.filename) {
      return copyRootFileSync(options);
    }
    target = options.destination.absolutePath;
    expect(options.expectedSourceIdentity).toEqual({ dev: admitted.dev, ino: admitted.ino });
    fs.renameSync(source.filename, `${source.filename}.retained`);
    fs.writeFileSync(source.filename, "replacement");
    try {
      return copyRootFileSync(options);
    } catch (error) {
      refused = error;
      throw error;
    }
  });

  expect(() => source.capture()).toThrow();
  expect(refused).toMatchObject({ code: "path-mismatch" });
  expect(target).toBeDefined();
  expect(fs.existsSync(target!)).toBe(false);
  expect(fs.readFileSync(`${source.filename}.retained`, "utf8")).toBe("pinned source");
  expect(fs.readFileSync(source.filename, "utf8")).toBe("replacement");
});

it("maps growth beyond the pinned size to the reload retry error with its cause", () => {
  const source = fixture(Buffer.from("bounded"), "fixture.js");
  const copyRootFileSync = fsSafeAdvanced.copyRootFileSync;
  let target: string | undefined;
  vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
    if (options.source.absolutePath === source.filename) {
      target = options.destination.absolutePath;
      fs.appendFileSync(source.filename, " growth");
    }
    return copyRootFileSync(options);
  });

  let failure: unknown;
  try {
    source.capture();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    message: "Plugin source changed while preparing its reload; retry after the edit finishes.",
    cause: { code: "too-large" },
  });
  expect(target).toBeDefined();
  expect(fs.existsSync(target!)).toBe(false);
});

it.each(["EIO", "EBADF"])("propagates fatal %s copy failures without retry", (code) => {
  const source = fixture(Buffer.from("captured"), "fixture.js");
  const copyRootFileSync = fsSafeAdvanced.copyRootFileSync;
  const failure = new FsSafeError("helper-failed", "guarded synchronous file copy failed", {
    cause: Object.assign(new Error("injected copy failure"), { code }),
  });
  const copies = vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
    if (options.source.absolutePath === source.filename) {
      throw failure;
    }
    return copyRootFileSync(options);
  });

  expect(() => source.capture()).toThrow(failure);
  expect(
    copies.mock.calls.filter(([options]) => options.source.absolutePath === source.filename),
  ).toHaveLength(1);
});

it.each([false, true])(
  "preserves disk-full diagnostics when capture cleanup fails: %s",
  (cleanupFails) => {
    const source = fixture(Buffer.from("captured"), "fixture.js");
    const copyRootFileSync = fsSafeAdvanced.copyRootFileSync;
    const cause = Object.assign(new Error("capture filesystem is full"), { code: "ENOSPC" });
    const primary = new FsSafeError("helper-failed", "guarded synchronous file copy failed", {
      cause,
    });
    const failure = cleanupFails
      ? new FsSafeError(primary.code, primary.message, {
          cause: new AggregateError(
            [primary, new Error("capture cleanup failed")],
            "copy and cleanup failed",
          ),
        })
      : primary;
    const copies = vi.spyOn(fsSafeAdvanced, "copyRootFileSync").mockImplementation((options) => {
      if (options.source.absolutePath === source.filename) {
        throw failure;
      }
      return copyRootFileSync(options);
    });

    let reported: unknown;
    try {
      source.capture();
    } catch (error) {
      reported = error;
    }
    expect(reported).toMatchObject({
      code: "ENOSPC",
      message: expect.stringContaining("capture filesystem is full"),
      cause: failure,
    });
    if (cleanupFails) {
      expect(reported).toHaveProperty("message", expect.stringContaining("capture cleanup failed"));
    }
    expect(
      copies.mock.calls.filter(([options]) => options.source.absolutePath === source.filename),
    ).toHaveLength(1);
  },
);
