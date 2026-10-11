import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";

const { createRequireMock, resolveRuntimeWorkerUrlMock } = vi.hoisted(() => ({
  createRequireMock: vi.fn(),
  resolveRuntimeWorkerUrlMock: vi.fn(),
}));
vi.mock("node:module", () => ({ createRequire: createRequireMock }));
vi.mock("./runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: resolveRuntimeWorkerUrlMock,
}));

let root: string;
let destination: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "0.1.0";
const nativeArch = process.arch;
const platformName = `@openclaw/proc-safe-freebsd-${nativeArch}`;
const supportsPosixFiles = process.platform !== "win32";
const runtimeBytes = Buffer.from("export const fixture = true;\n");
const packageFiles = {
  "package.json": JSON.stringify({
    name: "@openclaw/proc-safe",
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

function installedProcSafe() {
  const sourceRoot = path.join(root, "install", "node_modules", "@openclaw", "proc-safe");
  const nativeRoot = path.join(root, "install", "node_modules", platformName);
  const selectedNative = path.join(nativeRoot, "proc-safe-native.node");
  const sourceEntry = path.join(sourceRoot, "dist", "identity.js");
  for (const [relative, bytes] of Object.entries(packageFiles)) {
    write(path.join(sourceRoot, relative), bytes);
  }
  const selectedBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  write(selectedNative, selectedBytes);
  write(path.join(nativeRoot, "package.json"), JSON.stringify({ name: platformName, version }));

  const sourceIdentity = {
    readProcessIdentity: vi.fn(() => ({ startTimeSinceBootMicros: 5_200_002 })),
  };
  const privateIdentity = {
    readProcessIdentity: vi.fn(() => ({ startTimeSinceBootMicros: 5_200_002 })),
  };
  const privateModules = path.join(destination, "runtime", "node_modules");
  const privateEntry = path.join(privateModules, "@openclaw", "proc-safe", "dist", "identity.js");
  const privateNativePath = path.join(privateModules, platformName, "proc-safe-native.node");
  const cache: Record<string, { filename: string; loaded: boolean; exports: unknown }> = {
    [selectedNative]: { filename: selectedNative, loaded: true, exports: {} },
  };
  const sourceRequire = Object.assign(
    vi.fn(() => sourceIdentity),
    {
      cache,
      resolve: vi.fn((name: string) =>
        name.endsWith("/package.json") ? path.join(nativeRoot, "package.json") : selectedNative,
      ),
    },
  );
  const privateRequire = Object.assign(
    vi.fn(() => {
      const canonical = fs.realpathSync(privateNativePath);
      cache[canonical] = { filename: canonical, loaded: true, exports: {} };
      return privateIdentity;
    }),
    { cache },
  );
  createRequireMock.mockImplementation((entry: string) => {
    if (entry === sourceEntry) {
      return sourceRequire;
    }
    if (entry === privateEntry) {
      return privateRequire;
    }
    return {
      resolve: (name: string) =>
        name.endsWith("/package.json") ? path.join(sourceRoot, "package.json") : sourceEntry,
    };
  });
  return {
    sourceRoot,
    nativeRoot,
    selectedNative,
    selectedBytes,
    cache,
    sourceRequire,
    privateIdentity,
    privateRequire,
  };
}

beforeEach(() => {
  root = fs.realpathSync(tempDirs.make("openclaw-native-stage-"));
  destination = path.join(root, "handoff");
  const runtime = path.join(root, "managed-handoff-runtime.mjs");
  write(runtime, runtimeBytes);
  createRequireMock.mockReset();
  resolveRuntimeWorkerUrlMock.mockReturnValue(pathToFileURL(runtime));
});
afterEach(() => vi.restoreAllMocks());

describe("managed handoff native staging", () => {
  it("preserves the single-file stage outside FreeBSD", async () => {
    await withMockedPlatform("linux", async () => {
      const files = stageManagedHandoffRuntime(destination);
      expect(files).toEqual([path.join(destination, "runtime", "managed-handoff-runtime.mjs")]);
      expect(fs.readFileSync(files[0]!)).toEqual(runtimeBytes);
      expect(createRequireMock).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "copies private regular bytes through a temporary-directory alias=%s",
    async (alias) => {
      if (alias) {
        fs.symlinkSync(
          root,
          path.join(root, "alias"),
          process.platform === "win32" ? "junction" : "dir",
        );
        destination = path.join(root, "alias", "handoff");
      }
      const fixture = installedProcSafe();
      await withMockedPlatform("freebsd", async () => {
        const files = stageManagedHandoffRuntime(destination);
        const privateModules = path.join(destination, "runtime", "node_modules");
        expect(files).toEqual([
          path.join(destination, "runtime", "managed-handoff-runtime.mjs"),
          ...Object.keys(packageFiles).map((relative) =>
            path.join(privateModules, "@openclaw", "proc-safe", relative),
          ),
          path.join(privateModules, platformName, "package.json"),
          path.join(privateModules, platformName, "proc-safe-native.node"),
        ]);
        expect(fs.readFileSync(files.at(-1)!)).toEqual(fixture.selectedBytes);
        for (const [relative, bytes] of Object.entries(packageFiles)) {
          expect(
            fs.readFileSync(path.join(privateModules, "@openclaw", "proc-safe", relative), "utf8"),
          ).toBe(bytes);
        }
        for (const file of files) {
          expect(fs.lstatSync(file).isFile()).toBe(true);
          if (supportsPosixFiles) {
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
          }
        }
        expect(fixture.privateIdentity.readProcessIdentity).toHaveBeenCalledExactlyOnceWith(
          process.pid,
        );
      });
    },
  );

  it("rejects an addon that was not loaded from the selected package", async () => {
    const fixture = installedProcSafe();
    delete fixture.cache[fixture.selectedNative];
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("could not identify");
      expect(fixture.privateRequire).not.toHaveBeenCalled();
    });
  });

  it("rejects a selected addon outside the platform package entry", async () => {
    const fixture = installedProcSafe();
    fixture.sourceRequire.resolve.mockImplementation((name: string) =>
      name.endsWith("/package.json")
        ? path.join(fixture.nativeRoot, "package.json")
        : path.join(fixture.nativeRoot, "other.node"),
    );
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("unexpected package path");
    });
  });

  it.skipIf(!supportsPosixFiles).each(["LICENSE", "dist", "dist/identity.js", "dist/native.js"])(
    "rejects source symlinks: %s",
    async (relative) => {
      const fixture = installedProcSafe();
      const original = path.join(fixture.sourceRoot, relative);
      const moved = path.join(root, "substitute");
      fs.renameSync(original, moved);
      fs.symlinkSync(moved, original);
      await withMockedPlatform("freebsd", async () => {
        expect(() => stageManagedHandoffRuntime(destination)).toThrow(
          /regular package|unexpected package path/u,
        );
        expect(fixture.privateRequire).not.toHaveBeenCalled();
      });
    },
  );

  it.skipIf(!supportsPosixFiles)("rejects an addon symlink to a different package", async () => {
    const fixture = installedProcSafe();
    const substitute = path.join(root, "substitute", "proc-safe-native.node");
    write(substitute, fixture.selectedBytes);
    fs.unlinkSync(fixture.selectedNative);
    fs.symlinkSync(substitute, fixture.selectedNative);
    fixture.sourceRequire.resolve.mockImplementation((name: string) =>
      name.endsWith("/package.json") ? path.join(fixture.nativeRoot, "package.json") : substitute,
    );
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("unexpected package path");
      expect(fixture.privateRequire).not.toHaveBeenCalled();
    });
  });

  it("rejects private loading that reuses the source addon", async () => {
    const fixture = installedProcSafe();
    fixture.privateRequire.mockImplementation(() => fixture.privateIdentity);
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("could not identify");
    });
  });

  it("refuses a native package version outside the root's exact pin", async () => {
    const fixture = installedProcSafe();
    write(
      path.join(fixture.nativeRoot, "package.json"),
      JSON.stringify({ name: platformName, version: "0.0.0" }),
    );
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("version does not match");
      expect(fixture.privateRequire).not.toHaveBeenCalled();
    });
  });

  it("requires the private runtime to reproduce the source identity", async () => {
    const fixture = installedProcSafe();
    fixture.privateIdentity.readProcessIdentity.mockReturnValue({ startTimeSinceBootMicros: 0 });
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("did not load its private");
    });
  });

  it("keeps the sealed loader from loading an external replacement addon", async () => {
    const require = Object.assign(vi.fn(), {
      resolve: () => path.join(root, "external", "proc-safe-native.node"),
    });
    createRequireMock.mockReturnValue(require);
    const { loadFreeBsdProcessIdentityNative } =
      await import("./update-managed-service-handoff-native-loader.js");
    expect(loadFreeBsdProcessIdentityNative).toThrow(
      "cannot use an external FreeBSD native runtime",
    );
    expect(require).not.toHaveBeenCalled();
  });

  it("refuses external resource roots before loading a dependency", async () => {
    const previous = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/external-resources",
    });
    try {
      await withMockedPlatform("freebsd", async () => {
        expect(() => stageManagedHandoffRuntime(destination)).toThrow(
          "external FreeBSD native resource path",
        );
        expect(createRequireMock).not.toHaveBeenCalled();
      });
    } finally {
      if (previous) {
        Object.defineProperty(process, "resourcesPath", previous);
      } else {
        Reflect.deleteProperty(process, "resourcesPath");
      }
    }
  });
});
