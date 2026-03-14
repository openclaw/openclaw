import path from "node:path";
import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const copyToClipboard = vi.fn();
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

type FakeFsEntry = { kind: "file"; content: string } | { kind: "dir" };

const state = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  counter: 0,
}));

const abs = (p: string) => path.resolve(p);

function setFile(p: string, content = "") {
  const resolved = abs(p);
  state.entries.set(resolved, { kind: "file", content });
  setDir(path.dirname(resolved));
}

function setDir(p: string) {
  const resolved = abs(p);
  if (!state.entries.has(resolved)) {
    state.entries.set(resolved, { kind: "dir" });
  }
}

function copyTree(src: string, dest: string) {
  const srcAbs = abs(src);
  const destAbs = abs(dest);
  const srcPrefix = `${srcAbs}${path.sep}`;
  for (const [key, entry] of state.entries.entries()) {
    if (key === srcAbs || key.startsWith(srcPrefix)) {
      const rel = key === srcAbs ? "" : key.slice(srcPrefix.length);
      const next = rel ? path.join(destAbs, rel) : destAbs;
      state.entries.set(next, entry);
    }
  }
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);

  const wrapped = {
    ...actual,
    existsSync: (p: string) => state.entries.has(absInMock(p)),
    mkdirSync: (p: string, _opts?: unknown) => {
      setDir(p);
    },
    writeFileSync: (p: string, content: string) => {
      setFile(p, content);
    },
    renameSync: (from: string, to: string) => {
      const fromAbs = absInMock(from);
      const toAbs = absInMock(to);
      const entry = state.entries.get(fromAbs);
      if (!entry) {
        throw new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      }
      state.entries.delete(fromAbs);
      state.entries.set(toAbs, entry);
    },
    rmSync: (p: string) => {
      const root = absInMock(p);
      const prefix = `${root}${pathMod.sep}`;
      const keys = Array.from(state.entries.keys());
      for (const key of keys) {
        if (key === root || key.startsWith(prefix)) {
          state.entries.delete(key);
        }
      }
    },
    mkdtempSync: (prefix: string) => {
      const dir = `${prefix}${state.counter++}`;
      setDir(dir);
      return dir;
    },
    promises: {
      ...actual.promises,
      cp: async (src: string, dest: string, _opts?: unknown) => {
        copyTree(src, dest);
      },
    },
  };

  return { ...wrapped, default: wrapped };
});

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let resolveBundledExtensionRootDir: typeof import("./browser-cli-extension.js").resolveBundledExtensionRootDir;
let installChromeExtension: typeof import("./browser-cli-extension.js").installChromeExtension;
let registerBrowserExtensionCommands: typeof import("./browser-cli-extension.js").registerBrowserExtensionCommands;

beforeAll(async () => {
  ({ resolveBundledExtensionRootDir, installChromeExtension, registerBrowserExtensionCommands } =
    await import("./browser-cli-extension.js"));
});

beforeEach(() => {
  state.entries.clear();
  state.counter = 0;
  copyToClipboard.mockClear();
  copyToClipboard.mockResolvedValue(false);
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
});

function writeManifest(dir: string) {
  setDir(dir);
  setFile(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
}

describe("bundled extension resolver (fs-mocked)", () => {
  it("walks up to find the assets directory", () => {
    const root = abs("/tmp/openclaw-ext-root");
    const here = path.join(root, "dist", "cli");
    const assets = path.join(root, "assets", "chrome-extension");

    writeManifest(assets);
    setDir(here);

    expect(resolveBundledExtensionRootDir(here)).toBe(assets);
  });

  it("prefers the nearest assets directory", () => {
    const root = abs("/tmp/openclaw-ext-root-nearest");
    const here = path.join(root, "dist", "cli");
    const distAssets = path.join(root, "dist", "assets", "chrome-extension");
    const rootAssets = path.join(root, "assets", "chrome-extension");

    writeManifest(distAssets);
    writeManifest(rootAssets);
    setDir(here);

    expect(resolveBundledExtensionRootDir(here)).toBe(distAssets);
  });
});

describe("browser extension install (fs-mocked)", () => {
  it("installs into the state dir (never node_modules)", async () => {
    const tmp = abs("/tmp/openclaw-ext-install");
    const sourceDir = path.join(tmp, "source-ext");
    writeManifest(sourceDir);
    setFile(path.join(sourceDir, "test.txt"), "ok");

    const result = await installChromeExtension({ stateDir: tmp, sourceDir });

    expect(result.path).toBe(path.join(tmp, "browser", "chrome-extension"));
    expect(state.entries.has(abs(path.join(result.path, "manifest.json")))).toBe(true);
    expect(state.entries.has(abs(path.join(result.path, "test.txt")))).toBe(true);
    expect(result.path.includes("node_modules")).toBe(false);
  });

  it("copies extension path to clipboard", async () => {
    const tmp = abs("/tmp/openclaw-ext-path");
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmp }, async () => {
      copyToClipboard.mockResolvedValue(true);

      const dir = path.join(tmp, "browser", "chrome-extension");
      writeManifest(dir);

      const program = new Command();
      const browser = program.command("browser").option("--json", "JSON output", false);
      registerBrowserExtensionCommands(
        browser,
        (cmd) => cmd.parent?.opts?.() as { json?: boolean },
      );

      await program.parseAsync(["browser", "extension", "path"], { from: "user" });
      expect(copyToClipboard).toHaveBeenCalledWith(dir);
    });
  });
});
