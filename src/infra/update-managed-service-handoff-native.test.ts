import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const version = "3.2.1";
const nativeArch = process.arch;
const supportsPosixFiles = process.platform !== "win32";
const runtimeBytes = Buffer.from("export const fixture = true;\n");
const packageFiles = {
  "package.json": JSON.stringify({ name: "koffi", version }),
  "indirect.cjs": "public loader fixture",
  "src/koffi/indirect.cjs": "native loader fixture",
  "LICENSE.txt": "license fixture",
};

function write(file: string, bytes: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function installedKoffi(selected: "prebuilt" | "canonical", both = false) {
  const sourceRoot = path.join(root, "install", "node_modules", "koffi");
  const optionalRoot = path.join(
    root,
    "install",
    "node_modules",
    "@koromix",
    `koffi-freebsd-${nativeArch}`,
  );
  const canonicalNative = path.join(
    sourceRoot,
    "build",
    "koffi",
    `freebsd_${nativeArch}`,
    "koffi.node",
  );
  const optionalNative = path.join(optionalRoot, `freebsd_${nativeArch}`, "koffi.node");
  const selectedNative = selected === "prebuilt" ? optionalNative : canonicalNative;
  const sourceEntry = path.join(sourceRoot, "indirect.cjs");
  for (const [relative, bytes] of Object.entries(packageFiles)) {
    write(path.join(sourceRoot, relative), bytes);
  }
  const selectedBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, selected === "prebuilt" ? 1 : 2]);
  write(selectedNative, selectedBytes);
  if (both) {
    write(selected === "prebuilt" ? canonicalNative : optionalNative, "unselected addon");
  }
  // Ports keeps optional metadata after removing the prebuilt addon.
  write(path.join(optionalRoot, "index.js"), "optional entry fixture");
  write(path.join(optionalRoot, "package.json"), JSON.stringify({ version }));

  const sourceNative = {};
  const privateNative = {};
  const sourceKoffi = { version, default: sourceNative };
  const privateKoffi = { version, default: privateNative };
  const privateRoot = path.join(destination, "runtime", "node_modules", "koffi");
  const privateEntry = path.join(privateRoot, "indirect.cjs");
  const privateNativePath = path.join(
    privateRoot,
    "build",
    "koffi",
    `freebsd_${nativeArch}`,
    "koffi.node",
  );
  const cache: Record<string, { filename: string; loaded: boolean; exports: unknown }> = {
    source: { filename: selectedNative, loaded: true, exports: sourceNative },
  };
  const sourceRequire = Object.assign(
    vi.fn(() => sourceKoffi),
    {
      cache,
      resolve: vi.fn(() => path.join(optionalRoot, "index.js")),
    },
  );
  const privateRequire = Object.assign(
    vi.fn(() => {
      cache.private = { filename: privateNativePath, loaded: true, exports: privateNative };
      return privateKoffi;
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
    return { resolve: () => sourceEntry };
  });
  return {
    sourceRoot,
    selectedNative,
    selectedBytes,
    cache,
    sourceNative,
    privateKoffi,
    privateRequire,
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-stage-")));
  destination = path.join(root, "handoff");
  const runtime = path.join(root, "managed-handoff-runtime.mjs");
  write(runtime, runtimeBytes);
  createRequireMock.mockReset();
  resolveRuntimeWorkerUrlMock.mockReturnValue(pathToFileURL(runtime));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("managed handoff native staging", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "preserves the single-file %s stage",
    async (platform) => {
      await withMockedPlatform(platform, async () => {
        const files = stageManagedHandoffRuntime(destination);
        expect(files).toEqual([path.join(destination, "runtime", "managed-handoff-runtime.mjs")]);
        expect(fs.readFileSync(files[0]!)).toEqual(runtimeBytes);
        expect(fs.readdirSync(path.join(destination, "runtime"))).toEqual([
          "managed-handoff-runtime.mjs",
        ]);
        expect(createRequireMock).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { selected: "prebuilt" as const, both: false },
    { selected: "prebuilt" as const, both: true },
    { selected: "canonical" as const, both: false },
    { selected: "canonical" as const, both: true },
  ])("stages the loaded $selected addon with both=$both", async ({ selected, both }) => {
    const fixture = installedKoffi(selected, both);
    await withMockedPlatform("freebsd", async () => {
      const files = stageManagedHandoffRuntime(destination);
      const privateRoot = path.join(destination, "runtime", "node_modules", "koffi");
      expect(files).toEqual([
        path.join(destination, "runtime", "managed-handoff-runtime.mjs"),
        ...Object.keys(packageFiles).map((relative) => path.join(privateRoot, relative)),
        path.join(privateRoot, "build", "koffi", `freebsd_${nativeArch}`, "koffi.node"),
      ]);
      expect(fs.readFileSync(files.at(-1)!)).toEqual(fixture.selectedBytes);
      for (const file of files) {
        expect(fs.lstatSync(file).isFile()).toBe(true);
        if (supportsPosixFiles) {
          expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
      }
      expect(fs.readdirSync(path.join(destination, "runtime", "node_modules"))).toEqual(["koffi"]);
      expect(fixture.privateRequire).toHaveBeenCalledOnce();
    });
  });

  it("rejects missing and ambiguous loaded addon ownership", async () => {
    const fixture = installedKoffi("prebuilt");
    delete fixture.cache.source;
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("could not identify");
      fs.rmSync(destination, { recursive: true, force: true });
      fixture.cache.first = {
        filename: fixture.selectedNative,
        loaded: true,
        exports: fixture.sourceNative,
      };
      fixture.cache.second = fixture.cache.first!;
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("could not identify");
      expect(fixture.privateRequire).not.toHaveBeenCalled();
    });
  });

  it("rejects a selected addon outside the dependency's official layouts", async () => {
    const fixture = installedKoffi("prebuilt");
    const unexpected = path.join(root, "unexpected.node");
    write(unexpected, "unexpected addon");
    fixture.cache.source!.filename = unexpected;
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("unexpected package path");
      expect(fixture.privateRequire).not.toHaveBeenCalled();
    });
  });

  it.skipIf(!supportsPosixFiles)("rejects source file symlinks", async () => {
    const fixture = installedKoffi("canonical");
    const license = path.join(fixture.sourceRoot, "LICENSE.txt");
    fs.unlinkSync(license);
    fs.symlinkSync(path.join(fixture.sourceRoot, "indirect.cjs"), license);
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("regular package files");
      expect(fixture.privateRequire).not.toHaveBeenCalled();
    });
  });

  it("refuses a private native version mismatch before handing off", async () => {
    const fixture = installedKoffi("prebuilt");
    fixture.privateKoffi.version = "0.0.0";
    await withMockedPlatform("freebsd", async () => {
      expect(() => stageManagedHandoffRuntime(destination)).toThrow("did not load its private");
    });
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
