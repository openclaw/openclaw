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

  function readdirSyncMock(p: string, opts?: { withFileTypes?: boolean }) {
    const resolved = absInMock(p);
    if (!state.entries.has(resolved)) {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    }
    const prefix = `${resolved}${pathMod.sep}`;
    const seen = new Set<string>();
    const items: Array<{ name: string; kind: "file" | "dir" }> = [];
    for (const [key, entry] of state.entries.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rel = key.slice(prefix.length);
      const name = rel.split(pathMod.sep)[0];
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      items.push({ name, kind: entry.kind });
    }
    if (opts?.withFileTypes) {
      return items.map((i) => ({
        name: i.name,
        isFile: () => i.kind === "file",
        isDirectory: () => i.kind === "dir",
      }));
    }
    return items.map((i) => i.name);
  }

  const wrapped = {
    ...actual,
    existsSync: (p: string) => state.entries.has(absInMock(p)),
    mkdirSync: (p: string, _opts?: unknown) => {
      setDir(p);
    },
    readFileSync: (p: string, opts?: unknown) => {
      const resolved = absInMock(String(p));
      const entry = state.entries.get(resolved);
      if (!entry || entry.kind !== "file") {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      }
      const wantString =
        typeof opts === "string" || (opts && typeof opts === "object" && "encoding" in opts);
      return wantString ? entry.content : Buffer.from(entry.content);
    },
    readdirSync: readdirSyncMock,
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
let computeExtensionHash: typeof import("./browser-cli-extension.js").computeExtensionHash;
let ensureExtensionUpToDate: typeof import("./browser-cli-extension.js").ensureExtensionUpToDate;

beforeAll(async () => {
  ({
    resolveBundledExtensionRootDir,
    installChromeExtension,
    registerBrowserExtensionCommands,
    computeExtensionHash,
    ensureExtensionUpToDate,
  } = await import("./browser-cli-extension.js"));
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

  it("writes bundle hash after install", async () => {
    const tmp = abs("/tmp/openclaw-ext-hash");
    const sourceDir = path.join(tmp, "source-ext");
    writeManifest(sourceDir);
    setFile(path.join(sourceDir, "background.js"), "console.log('v1')");

    const result = await installChromeExtension({ stateDir: tmp, sourceDir });

    const hashEntry = state.entries.get(abs(path.join(result.path, ".bundle-hash")));
    expect(hashEntry).toBeDefined();
    expect(hashEntry?.kind).toBe("file");
    expect((hashEntry as { content: string }).content.length).toBeGreaterThan(0);
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

describe("computeExtensionHash (fs-mocked)", () => {
  it("returns deterministic hash for same content", () => {
    const dir = abs("/tmp/openclaw-hash-det");
    writeManifest(dir);
    setFile(path.join(dir, "background.js"), "alert(1)");

    const h1 = computeExtensionHash(dir);
    const h2 = computeExtensionHash(dir);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(16);
  });

  it("returns different hash when file content changes", () => {
    const dir1 = abs("/tmp/openclaw-hash-v1");
    writeManifest(dir1);
    setFile(path.join(dir1, "background.js"), "v1");

    const dir2 = abs("/tmp/openclaw-hash-v2");
    writeManifest(dir2);
    setFile(path.join(dir2, "background.js"), "v2");

    expect(computeExtensionHash(dir1)).not.toBe(computeExtensionHash(dir2));
  });

  it("returns empty string for non-existent directory", () => {
    expect(computeExtensionHash(abs("/tmp/no-such-dir"))).toBe("");
  });

  it("ignores .bundle-hash file in hash computation", () => {
    const dir = abs("/tmp/openclaw-hash-ignore");
    writeManifest(dir);
    setFile(path.join(dir, "background.js"), "code");
    const hashBefore = computeExtensionHash(dir);

    setFile(path.join(dir, ".bundle-hash"), "some-old-hash");
    const hashAfter = computeExtensionHash(dir);

    expect(hashBefore).toBe(hashAfter);
  });
});

describe("ensureExtensionUpToDate (fs-mocked)", () => {
  it("skips when extension was never installed", async () => {
    const tmp = abs("/tmp/openclaw-auto-never");
    const result = await ensureExtensionUpToDate({ stateDir: tmp });
    expect(result).toBe(false);
  });

  it("re-installs when hash file is missing (pre-hash install)", async () => {
    const tmp = abs("/tmp/openclaw-auto-nohash");
    const sourceDir = path.join(tmp, "source");
    writeManifest(sourceDir);
    setFile(path.join(sourceDir, "background.js"), "new-code");

    // Simulate a pre-hash install (no .bundle-hash file)
    const installed = path.join(tmp, "browser", "chrome-extension");
    writeManifest(installed);
    setFile(path.join(installed, "background.js"), "old-code");

    const result = await ensureExtensionUpToDate({ stateDir: tmp, sourceDir });
    expect(result).toBe(true);

    const hashEntry = state.entries.get(abs(path.join(installed, ".bundle-hash")));
    expect(hashEntry).toBeDefined();
  });

  it("skips when hashes match", async () => {
    const tmp = abs("/tmp/openclaw-auto-match");
    const sourceDir = path.join(tmp, "source");
    writeManifest(sourceDir);
    setFile(path.join(sourceDir, "background.js"), "code");

    await installChromeExtension({ stateDir: tmp, sourceDir });

    const result = await ensureExtensionUpToDate({ stateDir: tmp, sourceDir });
    expect(result).toBe(false);
  });

  it("re-installs when bundled extension changes", async () => {
    const tmp = abs("/tmp/openclaw-auto-stale");
    const sourceDir = path.join(tmp, "source");
    writeManifest(sourceDir);
    setFile(path.join(sourceDir, "background.js"), "v1");

    await installChromeExtension({ stateDir: tmp, sourceDir });

    // Simulate updating the bundled extension (new CLI version)
    setFile(path.join(sourceDir, "background.js"), "v2");

    const result = await ensureExtensionUpToDate({ stateDir: tmp, sourceDir });
    expect(result).toBe(true);
  });
});
