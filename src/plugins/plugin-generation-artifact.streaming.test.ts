import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const artifact of artifacts.splice(0)) {
    artifact.dispose();
  }
});

function fixture(bytes: Buffer) {
  const root = fs.realpathSync(temp.make("plugin-streaming-capture-"));
  const source = path.join(root, "source");
  const captures = path.join(root, "captures");
  fs.mkdirSync(source);
  fs.mkdirSync(captures);
  const filename = path.join(source, "fixture.bin");
  fs.writeFileSync(filename, bytes, { mode: 0o755 });
  return {
    filename,
    capture() {
      const artifact = withPluginSourceCaptureDirectory(captures, () =>
        capturePluginGenerationArtifact(source),
      );
      artifacts.push(artifact);
      return artifact;
    },
  };
}

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

it("rejects changed bytes even when source metadata retains its captured identity", () => {
  const source = fixture(Buffer.from("before"));
  const before = fs.statSync(source.filename, { bigint: true });
  const artifact = source.capture();
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
  expect(artifact.assertSourceCurrent).toThrow(
    "Plugin source changed while preparing its reload; retry after the edit finishes.",
  );
  expect(fs.readFileSync(artifact.resolve(source.filename), "utf8")).toBe("before");
});

it("bounds fresh verification when a source keeps growing during reads", () => {
  const source = fixture(Buffer.from("before"));
  const artifact = source.capture();
  const original = fs.statSync(source.filename);
  const readSync = fs.readSync;
  let reads = 0;
  vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    const length = Reflect.apply(readSync, fs, args);
    const stat = fs.fstatSync(args[0]);
    if (stat.dev === original.dev && stat.ino === original.ino) {
      if (++reads > 8) {
        throw new Error("Verification did not bound a growing source");
      }
      fs.appendFileSync(source.filename, "growth");
    }
    return length;
  });
  expect(artifact.assertSourceCurrent).toThrow(
    "Plugin source changed while preparing its reload; retry after the edit finishes.",
  );
  expect(reads).toBeLessThanOrEqual(2);
});

it("captures from the pinned descriptor when descriptor paths are unavailable", () => {
  const source = fixture(Buffer.from("captured"));
  const copyFileSync = fs.copyFileSync;
  vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
    if (typeof from === "string" && /^\/(?:proc\/self|dev)\/fd\//.test(from)) {
      throw Object.assign(new Error("Descriptor paths are unavailable"), { code: "ENOENT" });
    }
    return copyFileSync(from, to, mode);
  });
  const artifact = source.capture();
  expect(fs.readFileSync(artifact.resolve(source.filename), "utf8")).toBe("captured");
  expect(artifact.assertSourceCurrent).not.toThrow();
});
