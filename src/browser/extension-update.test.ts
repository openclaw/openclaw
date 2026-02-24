import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type FakeFsEntry = { kind: "file"; content: string } | { kind: "dir" };

const state = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
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
        throw new Error(`ENOENT: rename '${from}' -> '${to}'`);
      }
      state.entries.delete(fromAbs);
      state.entries.set(toAbs, entry);
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

let computeExtensionHash: typeof import("./extension-update.js").computeExtensionHash;
let installChromeExtension: typeof import("./extension-update.js").installChromeExtension;
let ensureExtensionUpToDate: typeof import("./extension-update.js").ensureExtensionUpToDate;

beforeAll(async () => {
  ({ computeExtensionHash, installChromeExtension, ensureExtensionUpToDate } =
    await import("./extension-update.js"));
});

beforeEach(() => {
  state.entries.clear();
});

function writeManifest(dir: string) {
  setDir(dir);
  setFile(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
}

describe("computeExtensionHash", () => {
  it("is deterministic", () => {
    const dir = abs("/tmp/ext-hash-det");
    writeManifest(dir);
    setFile(path.join(dir, "bg.js"), "code");
    expect(computeExtensionHash(dir)).toBe(computeExtensionHash(dir));
  });

  it("changes when file content changes", () => {
    const a = abs("/tmp/ext-hash-a");
    writeManifest(a);
    setFile(path.join(a, "bg.js"), "v1");

    const b = abs("/tmp/ext-hash-b");
    writeManifest(b);
    setFile(path.join(b, "bg.js"), "v2");

    expect(computeExtensionHash(a)).not.toBe(computeExtensionHash(b));
  });
});

describe("installChromeExtension", () => {
  it("writes .bundle-hash after install", async () => {
    const tmp = abs("/tmp/ext-install");
    const src = path.join(tmp, "src-ext");
    writeManifest(src);
    setFile(path.join(src, "bg.js"), "code");

    const { path: dest } = await installChromeExtension({ stateDir: tmp, sourceDir: src });
    expect(state.entries.has(abs(path.join(dest, ".bundle-hash")))).toBe(true);
  });
});

describe("ensureExtensionUpToDate", () => {
  it("returns false when extension was never installed", async () => {
    expect(await ensureExtensionUpToDate({ stateDir: abs("/tmp/ext-never") })).toBe(false);
  });

  it("returns true and re-installs when bundle changes", async () => {
    const tmp = abs("/tmp/ext-stale");
    const src = path.join(tmp, "src-ext");
    writeManifest(src);
    setFile(path.join(src, "bg.js"), "v1");

    await installChromeExtension({ stateDir: tmp, sourceDir: src });

    setFile(path.join(src, "bg.js"), "v2");
    expect(await ensureExtensionUpToDate({ stateDir: tmp, sourceDir: src })).toBe(true);
  });

  it("returns false when hashes match", async () => {
    const tmp = abs("/tmp/ext-fresh");
    const src = path.join(tmp, "src-ext");
    writeManifest(src);
    setFile(path.join(src, "bg.js"), "code");

    await installChromeExtension({ stateDir: tmp, sourceDir: src });
    expect(await ensureExtensionUpToDate({ stateDir: tmp, sourceDir: src })).toBe(false);
  });
});
