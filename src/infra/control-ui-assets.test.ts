import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeFsEntry = { kind: "file"; content: string } | { kind: "dir" };

const state = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  realpaths: new Map<string, string>(),
}));

const abs = (p: string) => path.resolve(p);

function setFile(p: string, content = "") {
  state.entries.set(abs(p), { kind: "file", content });
}

function setDir(p: string) {
  state.entries.set(abs(p), { kind: "dir" });
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const fixturesRoot = `${absInMock("fixtures")}${pathMod.sep}`;
  const isFixturePath = (p: string) => {
    const resolved = absInMock(p);
    return resolved === fixturesRoot.slice(0, -1) || resolved.startsWith(fixturesRoot);
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
      return entry.content;
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

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => null),
  resolveOpenClawPackageRootSync: vi.fn(() => null),
}));

describe("control UI assets helpers (fs-mocked)", () => {
  beforeEach(() => {
    state.entries.clear();
    state.realpaths.clear();
    vi.clearAllMocks();
  });

  it("resolves repo root from src argv1", async () => {
    const { resolveControlUiRepoRoot } = await import("./control-ui-assets.js");

    const root = abs("fixtures/ui-src");
    setFile(path.join(root, "ui", "vite.config.ts"), "export {};\n");

    const argv1 = path.join(root, "src", "index.ts");
    expect(resolveControlUiRepoRoot(argv1)).toBe(root);
  });

  it("resolves repo root by traversing up (dist argv1)", async () => {
    const { resolveControlUiRepoRoot } = await import("./control-ui-assets.js");

    const root = abs("fixtures/ui-dist");
    setFile(path.join(root, "package.json"), "{}\n");
    setFile(path.join(root, "ui", "vite.config.ts"), "export {};\n");

    const argv1 = path.join(root, "dist", "index.js");
    expect(resolveControlUiRepoRoot(argv1)).toBe(root);
  });

  it("resolves dist control-ui index path for dist argv1", async () => {
    const { resolveControlUiDistIndexPath } = await import("./control-ui-assets.js");

    const argv1 = abs(path.join("fixtures", "pkg", "dist", "index.js"));
    const distDir = path.dirname(argv1);
    await expect(resolveControlUiDistIndexPath(argv1)).resolves.toBe(
      path.join(distDir, "control-ui", "index.html"),
    );
  });

  it("uses resolveOpenClawPackageRoot when available", async () => {
    const openclawRoot = await import("./openclaw-root.js");
    const { resolveControlUiDistIndexPath } = await import("./control-ui-assets.js");

    const pkgRoot = abs("fixtures/openclaw");
    (
      openclawRoot.resolveOpenClawPackageRoot as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(pkgRoot);

    await expect(resolveControlUiDistIndexPath(abs("fixtures/bin/openclaw"))).resolves.toBe(
      path.join(pkgRoot, "dist", "control-ui", "index.html"),
    );
  });

  it("falls back to package.json name matching when root resolution fails", async () => {
    const { resolveControlUiDistIndexPath } = await import("./control-ui-assets.js");

    const root = abs("fixtures/fallback");
    setFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    setFile(path.join(root, "dist", "control-ui", "index.html"), "<html></html>\n");

    await expect(resolveControlUiDistIndexPath(path.join(root, "openclaw.mjs"))).resolves.toBe(
      path.join(root, "dist", "control-ui", "index.html"),
    );
  });

  it("returns null when fallback package name does not match", async () => {
    const { resolveControlUiDistIndexPath } = await import("./control-ui-assets.js");

    const root = abs("fixtures/not-openclaw");
    setFile(path.join(root, "package.json"), JSON.stringify({ name: "malicious-pkg" }));
    setFile(path.join(root, "dist", "control-ui", "index.html"), "<html></html>\n");

    await expect(resolveControlUiDistIndexPath(path.join(root, "index.mjs"))).resolves.toBeNull();
  });

  it("reports health for missing + existing dist assets", async () => {
    const { resolveControlUiDistIndexHealth } = await import("./control-ui-assets.js");

    const root = abs("fixtures/health");
    const indexPath = path.join(root, "dist", "control-ui", "index.html");

    await expect(resolveControlUiDistIndexHealth({ root })).resolves.toEqual({
      indexPath,
      exists: false,
    });

    setFile(indexPath, "<html></html>\n");
    await expect(resolveControlUiDistIndexHealth({ root })).resolves.toEqual({
      indexPath,
      exists: true,
    });
  });

  it("resolves control-ui root from override file or directory", async () => {
    const { resolveControlUiRootOverrideSync } = await import("./control-ui-assets.js");

    const root = abs("fixtures/override");
    const uiDir = path.join(root, "dist", "control-ui");
    const indexPath = path.join(uiDir, "index.html");

    setDir(uiDir);
    setFile(indexPath, "<html></html>\n");

    expect(resolveControlUiRootOverrideSync(uiDir)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(indexPath)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(path.join(uiDir, "missing.html"))).toBeNull();
  });

  it("resolves control-ui root for dist bundle argv1 and moduleUrl candidates", async () => {
    const openclawRoot = await import("./openclaw-root.js");
    const { resolveControlUiRootSync } = await import("./control-ui-assets.js");

    const pkgRoot = abs("fixtures/openclaw-bundle");
    (
      openclawRoot.resolveOpenClawPackageRootSync as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce(pkgRoot);

    const uiDir = path.join(pkgRoot, "dist", "control-ui");
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");

    // argv1Dir candidate: <argv1Dir>/control-ui
    expect(resolveControlUiRootSync({ argv1: path.join(pkgRoot, "dist", "bundle.js") })).toBe(
      uiDir,
    );

    // moduleUrl candidate: <moduleDir>/control-ui
    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "bundle.js")).toString();
    expect(resolveControlUiRootSync({ moduleUrl })).toBe(uiDir);
  });
});
