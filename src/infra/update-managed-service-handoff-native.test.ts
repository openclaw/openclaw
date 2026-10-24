import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform, withMockedPlatform } from "../test-utils/vitest-spies.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";

const mocks = vi.hoisted(() => ({ createRequire: vi.fn(), runtimeUrl: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: mocks.createRequire }));
// mock-isolation: Resolve synthetic package paths without loading the host's worker bootstrap.
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerUrl: mocks.runtimeUrl }));

let root: string;
let destination: string;
let fixture: ReturnType<typeof installedProcSafe>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "0.1.0";
const procSafe = "@openclaw/proc-safe";
const platformName = `@openclaw/proc-safe-freebsd-${process.arch}`;
const nativeMetadata = (pin: string) => JSON.stringify({ name: platformName, version: pin });
const supportsPosixFiles = process.platform !== "win32";
const runtimeBytes = Buffer.from("export const fixture = true;\n");
const packageFiles = {
  "package.json": JSON.stringify({
    name: procSafe,
    version,
    optionalDependencies: { [platformName]: version },
  }),
  LICENSE: "license fixture",
  "dist/identity.js": "public identity fixture",
  "dist/native.js": "native loader fixture",
};

function write(file: string, bytes: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

async function rejectsStaging(message: string | RegExp, privateRequire?: () => unknown) {
  expect(() => stageManagedHandoffRuntime(destination)).toThrow(message);
  if (privateRequire) {
    expect(privateRequire).not.toHaveBeenCalled();
  }
}

function installedProcSafe() {
  const sourceRoot = path.join(root, "install", "node_modules", procSafe);
  const nativeRoot = path.join(root, "install", "node_modules", platformName);
  const addon = path.join(nativeRoot, "proc-safe-native.node");
  const sourceEntry = path.join(sourceRoot, "dist", "identity.js");
  for (const [relative, bytes] of Object.entries(packageFiles)) {
    write(path.join(sourceRoot, relative), bytes);
  }
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  write(addon, bytes);
  write(path.join(nativeRoot, "package.json"), nativeMetadata(version));

  const observed = { startTimeSinceBootMicros: 5_200_002 };
  const sourceIdentity = { readProcessIdentity: vi.fn(() => observed) };
  const identity = { readProcessIdentity: vi.fn(() => observed) };
  const privateModules = path.join(destination, "runtime", "node_modules");
  const privateEntry = path.join(privateModules, procSafe, "dist", "identity.js");
  const privateNativePath = path.join(privateModules, platformName, "proc-safe-native.node");
  const cache = { [addon]: { filename: addon, loaded: true, exports: {} } };
  const resolve = vi.fn((name: string) =>
    name.endsWith("/package.json") ? path.join(nativeRoot, "package.json") : addon,
  );
  const source = Object.assign(
    vi.fn(() => sourceIdentity),
    { cache, resolve },
  );
  const staged = Object.assign(
    vi.fn(() => {
      const canonical = fs.realpathSync(privateNativePath);
      cache[canonical] = { filename: canonical, loaded: true, exports: {} };
      return identity;
    }),
    { cache },
  );
  const requires: Record<string, unknown> = { [sourceEntry]: source, [privateEntry]: staged };
  const rootRequire = {
    resolve: (name: string) =>
      name.endsWith("/package.json") ? path.join(sourceRoot, "package.json") : sourceEntry,
  };
  mocks.createRequire.mockImplementation((entry: string) => requires[entry] ?? rootRequire);
  return { sourceRoot, nativeRoot, addon, bytes, cache, source, identity, staged };
}

beforeEach(() => {
  root = fs.realpathSync(tempDirs.make("openclaw-native-stage-"));
  destination = path.join(root, "handoff");
  const runtime = path.join(root, "managed-handoff-runtime.mjs");
  write(runtime, runtimeBytes);
  mocks.createRequire.mockReset();
  mocks.runtimeUrl.mockReturnValue(pathToFileURL(runtime));
  fixture = installedProcSafe();
  mockProcessPlatform("freebsd");
});
afterEach(() => vi.restoreAllMocks());

it("preserves the single-file stage outside FreeBSD", async () => {
  await withMockedPlatform("linux", async () => {
    const files = stageManagedHandoffRuntime(destination);
    expect(files).toEqual([path.join(destination, "runtime", "managed-handoff-runtime.mjs")]);
    expect(fs.readFileSync(files[0]!)).toEqual(runtimeBytes);
    expect(mocks.createRequire).not.toHaveBeenCalled();
  });
});

it("copies private regular bytes through a temporary-directory alias", async () => {
  fs.symlinkSync(root, path.join(root, "alias"), supportsPosixFiles ? "dir" : "junction");
  destination = path.join(root, "alias", "handoff");
  fixture = installedProcSafe();
  const files = stageManagedHandoffRuntime(destination);
  const privateModules = path.join(destination, "runtime", "node_modules");
  const privatePackage = path.join(privateModules, procSafe);
  expect(files).toEqual([
    path.join(destination, "runtime", "managed-handoff-runtime.mjs"),
    ...Object.keys(packageFiles).map((relative) => path.join(privatePackage, relative)),
    path.join(privateModules, platformName, "package.json"),
    path.join(privateModules, platformName, "proc-safe-native.node"),
  ]);
  expect(fs.readFileSync(files.at(-1)!)).toEqual(fixture.bytes);
  for (const [relative, bytes] of Object.entries(packageFiles)) {
    expect(fs.readFileSync(path.join(privatePackage, relative), "utf8")).toBe(bytes);
  }
  for (const file of files) {
    expect(fs.lstatSync(file).isFile()).toBe(true);
    if (supportsPosixFiles) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  }
  expect(fixture.identity.readProcessIdentity).toHaveBeenCalledExactlyOnceWith(process.pid);
});

it.skipIf(!supportsPosixFiles).each(["LICENSE", "dist", "dist/native.js", "addon"])(
  "rejects source symlinks: %s",
  async (relative) => {
    const addon = relative === "addon";
    const original = addon ? fixture.addon : path.join(fixture.sourceRoot, relative);
    const moved = path.join(root, "substitute");
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original);
    if (addon) {
      fixture.source.resolve.mockImplementation((name: string) =>
        name.endsWith("/package.json") ? path.join(fixture.nativeRoot, "package.json") : moved,
      );
    }
    await rejectsStaging(
      addon ? "unexpected package path" : /regular package|unexpected package path/u,
      fixture.staged,
    );
  },
);

it("rejects an addon that was not loaded from the selected package", async () => {
  delete fixture.cache[fixture.addon];
  await rejectsStaging("could not identify", fixture.staged);
});

it("rejects private loading that reuses the source addon", async () => {
  fixture.staged.mockImplementation(() => fixture.identity);
  await rejectsStaging("could not identify");
});

it("refuses a native package version outside the root's exact pin", async () => {
  write(path.join(fixture.nativeRoot, "package.json"), nativeMetadata("0.0.0"));
  await rejectsStaging("version does not match", fixture.staged);
});

it("requires the private runtime to reproduce the source identity", async () => {
  fixture.identity.readProcessIdentity.mockReturnValue({ startTimeSinceBootMicros: 0 });
  await rejectsStaging("did not load its private");
});

it("keeps the sealed loader from loading an external replacement addon", async () => {
  const require = Object.assign(vi.fn(), {
    resolve: () => path.join(root, "external", "proc-safe-native.node"),
  });
  mocks.createRequire.mockReturnValue(require);
  const { loadFreeBsdProcessIdentityNative } =
    await import("./update-managed-service-handoff-native-loader.js");
  expect(loadFreeBsdProcessIdentityNative).toThrow("cannot use an external FreeBSD native runtime");
  expect(require).not.toHaveBeenCalled();
});

it("refuses external resource roots before loading a dependency", async () => {
  const previous = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/external-resources",
  });
  try {
    await rejectsStaging("external FreeBSD native resource path", mocks.createRequire);
  } finally {
    if (previous) {
      Object.defineProperty(process, "resourcesPath", previous);
    } else {
      Reflect.deleteProperty(process, "resourcesPath");
    }
  }
});
