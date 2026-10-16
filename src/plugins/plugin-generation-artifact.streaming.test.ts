import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { probeTreeClone, readCloneFileMetadata } from "@openclaw/fs-safe/copy";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { observeFileIo } from "./plugin-generation-capture.test-support.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
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
    bytes,
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

function interceptCopies(
  filename: string,
  intercept: (
    options: Parameters<typeof fsSafeAdvanced.copyRootFileSync>[0],
    copyFile: typeof fsSafeAdvanced.copyRootFileSync,
  ) => ReturnType<typeof fsSafeAdvanced.copyRootFileSync>,
) {
  const createBatch = fsSafeAdvanced.createRootFileCopyBatchSync;
  const copies = vi.fn(intercept);
  vi.spyOn(fsSafeAdvanced, "createRootFileCopyBatchSync").mockImplementation(() => {
    const batch = createBatch();
    const copyFile = batch.copyFile.bind(batch);
    return {
      ...batch,
      copyFile: (options) =>
        options.source.absolutePath === filename ? copies(options, copyFile) : copyFile(options),
    };
  });
  return copies;
}

function captureFailure(capture: () => unknown) {
  try {
    capture();
  } catch (error) {
    return error;
  }
  throw new Error("Expected capture to fail");
}

it.skipIf(process.platform === "win32")(
  "amortizes directory metadata reads when capturing sibling files",
  () => {
    const bytes = Buffer.alloc(64 * 1024 + 1, "S");
    const source = fixture(bytes, "fixture.dat");
    const lstatSync = fs.lstatSync;
    let directoryReads = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation((filename, options) => {
      const stat = lstatSync(filename, options);
      if (stat?.isDirectory()) {
        directoryReads += 1;
      }
      return stat;
    });
    source.capture();
    const singleFileReads = directoryReads;
    const siblings = Array.from({ length: 15 }, (_, index) =>
      path.join(path.dirname(source.filename), `sibling-${index}.dat`),
    );
    for (const sibling of siblings) {
      fs.writeFileSync(sibling, bytes);
    }
    directoryReads = 0;
    const captured = source.capture();
    const siblingFileReads = directoryReads;
    for (const sibling of [source.filename, ...siblings]) {
      expect(fs.readFileSync(captured.resolve(sibling))).toEqual(bytes);
    }
    expect(singleFileReads).toBeGreaterThan(0);
    // Keep per-file identity checks, but amortize directory admission across siblings.
    expect(siblingFileReads).toBeLessThanOrEqual(singleFileReads * (siblings.length + 1) * 0.85);
  },
);

it.each(["changed bytes", "escaping link"])(
  "rejects retained source with %s before admission",
  async (change) => {
    const bytes = Buffer.from("initial");
    const source = fixture(bytes, "fixture.dat");
    const outside = path.join(temp.make("plugin-custody-outside-"), "fixture.dat");
    fs.writeFileSync(outside, bytes);
    const copy = fs.cpSync;
    vi.spyOn(fs, "cpSync").mockImplementation((from, to, options) => {
      copy(from, to, options);
      const directory = String(to);
      const relative = fs
        .readdirSync(directory, { recursive: true, encoding: "utf8" })
        .find((name) => name.endsWith("fixture.dat"));
      if (!relative) {
        throw new Error("fixture copy is missing its payload");
      }
      const target = path.join(directory, relative);
      if (change === "escaping link") {
        fs.unlinkSync(target);
        fs.symlinkSync(outside, target);
      } else {
        fs.writeFileSync(target, "changed");
      }
    });
    await withPluginGenerationSourceCustody(async () => {
      expect(() => source.capture()).toThrow(
        change === "escaping link"
          ? "Cannot capture plugin source"
          : "Plugin source changed while preparing its reload",
      );
    });
    expect(fs.readFileSync(source.filename)).toEqual(bytes);
  },
);

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
  const observer = observeFileIo(source.filename, false);
  const { value: artifact, io } = observer.measure(() => source.capture());
  observer.restore();
  const { wholeFileReads, largestBuffer } = io;
  const streamedBytes = io.originalBytes + io.capturedBytes;

  expect(wholeFileReads).toBe(0);
  expect(largestBuffer).toBeLessThanOrEqual(1024 * 1024);
  // Receipt replay reads the copied payload; portable copies add one transfer.
  const passes = process.platform === "linux" || process.platform === "darwin" ? 1 : 2;
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
    const createFileSync = fsSafeAdvanced.createFileSync;
    let replaced = false;
    const replaceAfterClose = (copied: fsSafeAdvanced.OwnedFileDescriptorSync, target: string) => {
      const close = () => {
        copied.close();
        if (!replaced) {
          replaced = true;
          fs.renameSync(target, `${target}.original`);
          fs.writeFileSync(target, "replaced");
        }
      };
      return { ...copied, close, [Symbol.dispose]: close };
    };
    interceptCopies(source.filename, (options, copyRootFileSync) => {
      const copied = copyRootFileSync(options);
      return { ...copied, ...replaceAfterClose(copied, copied.path) };
    });
    vi.spyOn(fsSafeAdvanced, "createFileSync").mockImplementation((target, options) => {
      const copied = createFileSync(target, options);
      return path.basename(target) === path.basename(source.filename)
        ? replaceAfterClose(copied, target)
        : copied;
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

it.each(["replacement", "growth"] as const)(
  "rejects source %s after pinning without leaving a capture",
  (change) => {
    const source = fixture(Buffer.alloc(64 * 1024 + 1, "P"), "fixture.js");
    const admitted = fs.statSync(source.filename, { bigint: true });
    let target: string | undefined;
    let refused: unknown;
    interceptCopies(source.filename, (options, copyRootFileSync) => {
      target = options.destination.absolutePath;
      if (change === "replacement") {
        expect(options.expectedSourceIdentity).toEqual({ dev: admitted.dev, ino: admitted.ino });
        fs.renameSync(source.filename, `${source.filename}.retained`);
        fs.writeFileSync(source.filename, "replacement");
      } else {
        fs.appendFileSync(source.filename, " growth");
      }
      try {
        return copyRootFileSync(options);
      } catch (error) {
        refused = error;
        throw error;
      }
    });
    const failure = captureFailure(() => source.capture());
    if (change === "replacement") {
      expect(refused).toMatchObject({ code: "path-mismatch" });
      expect(fs.readFileSync(`${source.filename}.retained`)).toEqual(source.bytes);
      expect(fs.readFileSync(source.filename, "utf8")).toBe("replacement");
    } else {
      expect(failure).toMatchObject({
        message: "Plugin source changed while preparing its reload; retry after the edit finishes.",
        cause: { code: "too-large" },
      });
    }
    expect(target).toBeDefined();
    expect(fs.existsSync(target!)).toBe(false);
  },
);

it.each([
  ["EIO", false],
  ["EBADF", false],
  ["ENOSPC", false],
  ["ENOSPC", true],
] as const)(
  "reports %s copy failures without retry (cleanup failure: %s)",
  (code, cleanupFails) => {
    const source = fixture(Buffer.alloc(64 * 1024 + 1, "C"), "fixture.js");
    const full = code === "ENOSPC";
    const primary = new FsSafeError("helper-failed", "guarded synchronous file copy failed", {
      cause: Object.assign(
        new Error(full ? "capture filesystem is full" : "injected copy failure"),
        { code },
      ),
    });
    const failure = cleanupFails
      ? new FsSafeError(primary.code, primary.message, {
          cause: new AggregateError(
            [primary, new Error("capture cleanup failed")],
            "copy and cleanup failed",
          ),
        })
      : primary;
    const copies = interceptCopies(source.filename, () => {
      throw failure;
    });
    if (!full) {
      expect(() => source.capture()).toThrow(failure);
    } else {
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
        expect(reported).toHaveProperty(
          "message",
          expect.stringContaining("capture cleanup failed"),
        );
      }
    }
    expect(copies).toHaveBeenCalledOnce();
  },
);
