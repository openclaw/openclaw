import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeFsEntry = { kind: "file"; content: string } | { kind: "dir" };

const VITEST_FS_BASE = path.join(path.parse(process.cwd()).root, "__openclaw_vitest__");
const FIXTURE_BASE = path.join(VITEST_FS_BASE, "openclaw-root");

const state = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  realpaths: new Map<string, string>(),
}));

const abs = (p: string) => path.resolve(p);
const fx = (...parts: string[]) => path.join(FIXTURE_BASE, ...parts);

function setFile(p: string, content = "") {
  state.entries.set(abs(p), { kind: "file", content });
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const vitestRoot = `${absInMock(VITEST_FS_BASE)}${pathMod.sep}`;
  const isFixturePath = (p: string) => {
    const resolved = absInMock(p);
    return resolved === vitestRoot.slice(0, -1) || resolved.startsWith(vitestRoot);
  };
  const wrapped = {
    ...actual,
    existsSync: (p: string) =>
      isFixturePath(p) ? state.entries.has(absInMock(p)) : actual.existsSync(p),
    readFileSync: (p: string, encoding?: unknown) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return actual.readFileSync(p as any, encoding as any) as unknown;
      }
      const entry = state.entries.get(absInMock(p));
      if (!entry || entry.kind !== "file") {
        throw new Error(`ENOENT: no such file, open '${p}'`);
      }
      return encoding ? entry.content : Buffer.from(entry.content, "utf-8");
    },
    statSync: (p: string) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return actual.statSync(p as any) as unknown;
      }
      const entry = state.entries.get(absInMock(p));
      if (!entry) {
        throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
      }
      return {
        isFile: () => entry.kind === "file",
        isDirectory: () => entry.kind === "dir",
      };
    },
    realpathSync: (p: string) =>
      isFixturePath(p)
        ? (state.realpaths.get(absInMock(p)) ?? absInMock(p))
        : actual.realpathSync(p),
  };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const vitestRoot = `${absInMock(VITEST_FS_BASE)}${pathMod.sep}`;
  const isFixturePath = (p: string) => {
    const resolved = absInMock(p);
    return resolved === vitestRoot.slice(0, -1) || resolved.startsWith(vitestRoot);
  };
  const wrapped = {
    ...actual,
    readFile: async (p: string, encoding?: unknown) => {
      if (!isFixturePath(p)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await actual.readFile(p as any, encoding as any)) as unknown;
      }
      const entry = state.entries.get(absInMock(p));
      if (!entry || entry.kind !== "file") {
        throw new Error(`ENOENT: no such file, open '${p}'`);
      }
      return entry.content;
    },
  };
  return { ...wrapped, default: wrapped };
});

describe("resolveOpenClawPackageRoot", () => {
  beforeEach(() => {
    state.entries.clear();
    state.realpaths.clear();
  });

  it("resolves package root from .bin argv1", async () => {
    const { resolveOpenClawPackageRootSync } = await import("./openclaw-root.js");

    const project = fx("bin-scenario");
    const argv1 = path.join(project, "node_modules", ".bin", "openclaw");
    const pkgRoot = path.join(project, "node_modules", "openclaw");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));

    expect(resolveOpenClawPackageRootSync({ argv1 })).toBe(pkgRoot);
  });

  it("resolves package root via symlinked argv1", async () => {
    const { resolveOpenClawPackageRootSync } = await import("./openclaw-root.js");

    const project = fx("symlink-scenario");
    const bin = path.join(project, "bin", "openclaw");
    const realPkg = path.join(project, "real-pkg");
    state.realpaths.set(abs(bin), abs(path.join(realPkg, "openclaw.mjs")));
    setFile(path.join(realPkg, "package.json"), JSON.stringify({ name: "openclaw" }));

    expect(resolveOpenClawPackageRootSync({ argv1: bin })).toBe(realPkg);
  });

  it("prefers moduleUrl candidates", async () => {
    const { resolveOpenClawPackageRootSync } = await import("./openclaw-root.js");

    const pkgRoot = fx("moduleurl");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "index.js")).toString();

    expect(resolveOpenClawPackageRootSync({ moduleUrl })).toBe(pkgRoot);
  });

  it("returns null for non-openclaw package roots", async () => {
    const { resolveOpenClawPackageRootSync } = await import("./openclaw-root.js");

    const pkgRoot = fx("not-openclaw");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "not-openclaw" }));

    expect(resolveOpenClawPackageRootSync({ cwd: pkgRoot })).toBeNull();
  });

  it("async resolver matches sync behavior", async () => {
    const { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");

    const pkgRoot = fx("async");
    setFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));

    await expect(resolveOpenClawPackageRoot({ cwd: pkgRoot })).resolves.toBe(pkgRoot);
  });
});
