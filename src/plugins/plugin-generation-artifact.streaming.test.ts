import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    const openSync = fs.openSync;
    const closeSync = fs.closeSync;
    const copyFileSync = fs.copyFileSync;
    let destination: { path: string; fd: number } | undefined;
    let replaced = false;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      if (typeof from === "string" && /^\/(?:proc\/self|dev)\/fd\//.test(from)) {
        throw Object.assign(new Error("Descriptor paths are unavailable"), { code: "ENOENT" });
      }
      return copyFileSync(from, to, mode);
    });
    vi.spyOn(fs, "openSync").mockImplementation((filename, flags, mode) => {
      const fd = openSync(filename, flags, mode);
      if (
        typeof filename === "string" &&
        filename !== source.filename &&
        path.basename(filename) === "fixture.js" &&
        (flags === "w" || flags === "w+")
      ) {
        destination = { path: filename, fd };
      }
      return fd;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      closeSync(fd);
      if (!replaced && destination?.fd === fd) {
        replaced = true;
        fs.renameSync(destination.path, `${destination.path}.original`);
        fs.writeFileSync(destination.path, "replaced");
      }
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

const descriptorCopyCases = [
  {
    label: "Node on Linux has no descriptor paths",
    platform: "linux",
    isBun: false,
    code: "ENOENT",
    shouldCapture: true,
  },
  {
    label: "Bun on macOS returns EBADF",
    platform: "darwin",
    isBun: true,
    code: "EBADF",
    shouldCapture: true,
  },
  {
    label: "Node on macOS returns EBADF",
    platform: "darwin",
    isBun: false,
    code: "EBADF",
    shouldCapture: false,
  },
  {
    label: "Bun on Linux returns EBADF",
    platform: "linux",
    isBun: true,
    code: "EBADF",
    shouldCapture: false,
  },
  {
    label: "Bun on macOS returns EIO",
    platform: "darwin",
    isBun: true,
    code: "EIO",
    shouldCapture: false,
  },
] as const;

it.each(descriptorCopyCases)(
  "handles $label at the generation-capture boundary",
  ({ platform, isBun, code, shouldCapture }) => {
    const bytes = code === "ENOENT" ? Buffer.from("captured") : Buffer.alloc(172_832, "B");
    const source = fixture(bytes, code === "ENOENT" ? "fixture.js" : "fixture.bin");
    const opens = vi.spyOn(fs, "openSync");
    const realProcess = process;
    vi.stubGlobal(
      "process",
      new Proxy(realProcess, {
        get(target, property) {
          if (property === "platform") {
            return platform;
          }
          if (property === "versions") {
            const versions = { ...target.versions };
            if (isBun) {
              versions.bun = "1.4.2";
            } else {
              delete versions.bun;
            }
            return versions;
          }
          return Reflect.get(target, property, target);
        },
      }),
    );

    const copyFileSync = fs.copyFileSync;
    let injectedError = false;
    const descriptorPrefix = platform === "linux" ? "/proc/self/fd/" : "/dev/fd/";
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      if (
        typeof from === "string" &&
        from.startsWith(descriptorPrefix) &&
        typeof to === "string" &&
        to.endsWith(`${path.sep}${path.basename(source.filename)}`)
      ) {
        injectedError = true;
        throw Object.assign(new Error("Simulated descriptor-copy failure"), { code });
      }
      return copyFileSync(from, to, mode);
    });

    if (shouldCapture) {
      const artifact = source.capture();
      const captured = artifact.resolve(source.filename);
      if (code === "ENOENT") {
        // Receipt admission reopens the private copy once. A separate initial hash
        // would repeat the expensive Windows open without strengthening that admission.
        expect(
          opens.mock.calls.filter(
            ([filename, flags]) => filename === captured && flags !== "w" && flags !== "w+",
          ),
        ).toHaveLength(1);
        expect(fs.readFileSync(captured, "utf8")).toBe("captured");
      }
      expect(fs.readFileSync(captured)).toEqual(bytes);
      expect(artifact.assertSourceCurrent).not.toThrow();
    } else {
      expect(() => source.capture()).toThrow("Simulated descriptor-copy failure");
    }
    expect(injectedError).toBe(true);
  },
);
