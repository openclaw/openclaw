import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";

const state = vi.hoisted(() => ({ runCommandWithTimeout: vi.fn() }));

const successfulBuild = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root = "";
const abs = (p: string) => path.resolve(root, p);

function setFile(p: string, content = "") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function sourceCheckout(relativePath: string) {
  const dir = abs(relativePath);
  setFile(path.join(dir, "ui", "vite.config.ts"));
  setFile(path.join(dir, "scripts", "ui.js"));
  return dir;
}

const uiIndex = (dir: string) => path.join(dir, "dist", "control-ui", "index.html");
const buildFailure = (message: string) => ({ ok: false, message });
const buildExit = (stderr: string) => ({ ...successfulBuild, code: 1, stderr });

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => null),
  resolveOpenClawPackageRootSync: vi.fn(() => null),
}));
// mock-isolation: Build outcomes are supplied without starting package-manager processes.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: state.runCommandWithTimeout }));

const { runCommandWithTimeout: runRealCommandWithTimeout } =
  await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");

const {
  ensureControlUiAssetsBuilt,
  inspectControlUiRootAssets,
  resolveControlUiAssetHealth,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} = await import("./control-ui-assets.js");
const openclawRoot = await import("./openclaw-root.js");

const expectBuildFailure = (dir: string, message: string) =>
  expect(ensureControlUiAssetsBuilt(undefined, { root: dir })).resolves.toEqual(
    buildFailure(message),
  );
const expectHealth = (
  options: Parameters<typeof resolveControlUiAssetHealth>[0],
  expected: Awaited<ReturnType<typeof resolveControlUiAssetHealth>>,
) => expect(resolveControlUiAssetHealth(options)).resolves.toEqual(expected);

describe("control UI assets helpers", () => {
  beforeEach(() => {
    root = tempDirs.make("openclaw-control-ui-assets-");
    state.runCommandWithTimeout.mockReset();
    vi.clearAllMocks();
    vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockReset().mockReturnValue(null);
  });

  it("distinguishes missing, incomplete, and ready startup bundles", async () => {
    const indexPath = uiIndex(root);

    await expectHealth({ root }, { kind: "missing-index", indexPath });
    setFile(indexPath, '<script src="./assets/startup.js"></script>');
    await expectHealth(
      { root },
      { kind: "incomplete", indexPath, missingAsset: "assets/startup.js" },
    );

    setFile(path.join(root, "dist", "control-ui", "assets", "startup.js"));
    await expectHealth({ root }, { kind: "ready", indexPath });
  });

  it.each([
    { marker: `runtime-b-${"b".repeat(64)}`, kind: "ready" },
    { marker: `dev-${"a".repeat(64)}`, kind: "ready" },
    { marker: `runtime-b-other-${"a".repeat(64)}`, kind: "stale" },
  ])(
    "checks the runtime identity independently of its public digest: $marker",
    async ({ marker, kind }) => {
      const assetRoot = path.join(root, "dist", "control-ui");
      setFile(
        path.join(assetRoot, "index.html"),
        `<html data-openclaw-control-ui-build-id="${marker}"></html>`,
      );
      expect(inspectControlUiRootAssets(assetRoot, "runtime-b").kind).toBe(kind);
      await expect(
        resolveControlUiAssetHealth({ root, expectedBuildId: "runtime-b" }),
      ).resolves.toMatchObject({ kind });
      // Updaters may inspect a newly built target from an older running process.
      await expect(resolveControlUiAssetHealth({ root })).resolves.toMatchObject({ kind: "ready" });
    },
  );

  it("bounds each served route without adding inactive preload variants together", () => {
    const indexPath = path.join(root, "index.html");
    const reference = '<link rel="modulepreload" href="./assets/startup.js">';
    const route = (name: string, count: number) =>
      `<template data-openclaw-route-preloads="${name}">${reference.repeat(count)}</template>`;
    setFile(path.join(root, "assets", "startup.js"));
    setFile(indexPath, reference + route("chat", 90) + route("new", 90));
    expect(inspectControlUiRootAssets(root).kind).toBe("ready");

    setFile(indexPath, reference + route("chat", 90) + route("new", 128));
    expect(inspectControlUiRootAssets(root)).toMatchObject({
      kind: "incomplete",
      missingAsset: "too many startup assets",
    });
  });

  it("still validates assets and traversal inside every selectable preload route", () => {
    const indexPath = path.join(root, "index.html");
    setFile(path.join(root, "assets", "startup.js"));
    for (const route of ["chat", "new"]) {
      const prefix = '<template data-openclaw-route-preloads="' + route + '">';
      setFile(
        indexPath,
        '<script src="./assets/startup.js"></script>' +
          prefix +
          '<link href="./assets/missing.js"></template>',
      );
      expect(inspectControlUiRootAssets(root)).toMatchObject({
        kind: "incomplete",
        missingAsset: "assets/missing.js",
      });
      setFile(indexPath, prefix + '<link href="../assets/startup.js"></template>');
      expect(inspectControlUiRootAssets(root).kind).toBe("incomplete");
    }
  });

  it("keeps a truncated build failure diagnostic within its UTF-16 limit", async () => {
    root = sourceCheckout("fixtures/build-failure");
    state.runCommandWithTimeout.mockResolvedValueOnce(buildExit(`${"y".repeat(238)}🚀xx`));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const onBuildStart = vi.fn();

    const result = await ensureControlUiAssetsBuilt(runtime, { root, onBuildStart });
    expect(result).toEqual(buildFailure(`Control UI build failed: ${"y".repeat(238)}…`));
    expect(onBuildStart).toHaveBeenCalledOnce();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("preserves empty terminal output in build failures", async () => {
    root = sourceCheckout("fixtures/build-diagnostic");
    state.runCommandWithTimeout.mockResolvedValueOnce({
      ...buildExit("\u001b[0m\n\u0007\r\n"),
      stdout: "unrelated standard output",
    });

    await expectBuildFailure(root, "Control UI build failed: exit 1");
  });

  it("reports the real build process outcome for exit 1", async () => {
    root = sourceCheckout("fixtures/build-process");
    const diagnostic = 'Error: Cannot resolve package entry "example-package/missing"';
    const stderr = [
      ...Array.from({ length: 15 }, () => "warning: error reporting is enabled"),
      "\u001b[31merror during build:",
      diagnostic,
      ...Array.from({ length: 20 }, (_, index) => `    at loadModule (build.js:${index + 1}:1)`),
      "  {",
      "    code: 'ERR_MODULE_NOT_FOUND',",
      "    plugin: 'example-plugin'",
      "  }\u001b[0m",
    ].join("\r\n");
    setFile(path.join(root, "package.json"), '{"type":"commonjs"}');
    setFile(
      path.join(root, "scripts", "ui.js"),
      `process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = 1;
`,
    );
    state.runCommandWithTimeout.mockImplementationOnce(runRealCommandWithTimeout);

    const result = await ensureControlUiAssetsBuilt(undefined, { root });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.message).toMatch(`Control UI build failed: error during build: ${diagnostic}`);
      const summary = result.message.slice("Control UI build failed: ".length);
      expect(summary).toHaveLength(240);
      expect(summary.endsWith("…")).toBe(true);
      expect(summary).not.toMatch(/warning|\p{Cc}/u);
    }
  });

  it("tells packaged installs to reinstall when their bundled assets are missing", async () => {
    const indexPath = uiIndex(root);

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toEqual(
      buildFailure(
        `Missing Control UI assets at ${indexPath}. Reinstall OpenClaw to restore bundled Control UI assets.`,
      ),
    );
  });

  it("ignores inline and external startup references in otherwise valid first-party HTML", async () => {
    setFile(
      uiIndex(root),
      [
        "<script>console.log('inline')</script>",
        '<script src="https://example.invalid/assets/external.js"></script>',
        '<script src="//example.invalid/assets/external.js"></script>',
        '<link href="data:text/css,body{}" rel="stylesheet">',
      ].join(""),
    );

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("does not read oversized first-party index documents as healthy", async () => {
    const uiRoot = path.join(root, "dist", "control-ui");
    setFile(path.join(uiRoot, "index.html"), "x".repeat(256 * 1024));
    expect(inspectControlUiRootAssets(uiRoot).kind).toBe("ready");

    setFile(path.join(uiRoot, "index.html"), "x".repeat(256 * 1024 + 1));

    await expect(ensureControlUiAssetsBuilt(undefined, { root })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("index.html exceeds its size limit"),
    });
  });

  it("enforces the index limit when the file grows after metadata admission", () => {
    const indexPath = path.join(root, "index.html");
    setFile(indexPath, "<html></html>");
    const identity = fs.statSync(indexPath);
    const statSync = fs.statSync;
    const fstatSync = fs.fstatSync;
    let grew = false;
    const grow = (stat: fs.Stats | fs.BigIntStats) => {
      if (!grew && BigInt(stat.ino) === BigInt(identity.ino)) {
        grew = true;
        fs.appendFileSync(indexPath, "x".repeat(256 * 1024));
      }
    };
    const pathStat = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const stat = statSync(...args);
      if (stat) {
        grow(stat);
      }
      return stat;
    });
    const descriptorStat = vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      const stat = fstatSync(...args);
      grow(stat);
      return stat;
    });
    try {
      expect(inspectControlUiRootAssets(root)).toEqual({
        kind: "incomplete",
        indexPath,
        missingAsset: "index.html exceeds its size limit",
      });
      expect(grew).toBe(true);
    } finally {
      pathStat.mockRestore();
      descriptorStat.mockRestore();
    }
  });

  it("builds the source checkout selected by canonical package-root discovery", async () => {
    const packagedRoot = abs("fixtures/package-owner");
    const checkoutRoot = sourceCheckout("fixtures/checkout-owner");
    const indexPath = uiIndex(checkoutRoot);
    vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockImplementation((options) =>
      options.moduleUrl ? packagedRoot : checkoutRoot,
    );
    state.runCommandWithTimeout.mockImplementationOnce(async () => {
      setFile(indexPath);
      return successfulBuild;
    });

    const runtime = { log: vi.fn<RuntimeEnv["log"]>(), error: vi.fn(), exit: vi.fn() };
    await expect(ensureControlUiAssetsBuilt(runtime)).resolves.toMatchObject({ ok: true });
    const message = runtime.log.mock.calls.flat().join("\n");
    const commands = [...message.matchAll(/`(pnpm [^`]+)`/gu)].map((match) => match[1]);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain(checkoutRoot);
      expect(command).not.toContain(packagedRoot);
    }
    expect(state.runCommandWithTimeout).toHaveBeenCalledWith(
      [process.execPath, path.join(checkoutRoot, "scripts", "ui.js"), "build"],
      expect.objectContaining({ cwd: checkoutRoot }),
    );
  });

  it("forces a rebuild of an existing source bundle and forwards cancellation", async () => {
    root = sourceCheckout("fixtures/force-build");
    const controller = new AbortController();
    setFile(uiIndex(root));
    state.runCommandWithTimeout.mockResolvedValueOnce(successfulBuild);

    await expect(
      ensureControlUiAssetsBuilt(undefined, { root, force: true, signal: controller.signal }),
    ).resolves.toMatchObject({ ok: true });
    expect(state.runCommandWithTimeout).toHaveBeenCalledWith(
      [process.execPath, path.join(root, "scripts", "ui.js"), "build"],
      { cwd: root, timeoutMs: 600_000, signal: controller.signal },
    );
  });

  it("normalizes rejected build launches into a bounded failure", async () => {
    root = sourceCheckout("fixtures/build-rejection");
    state.runCommandWithTimeout.mockRejectedValueOnce(new Error("details\nspawn ENOENT"));

    await expectBuildFailure(root, "Control UI build failed: details spawn ENOENT");
  });

  it.each([
    { termination: "signal", message: "Control UI build canceled." },
    { termination: "no-output-timeout", message: "Control UI build timed out." },
  ] as const)("normalizes $termination build termination", async ({ termination, message }) => {
    root = sourceCheckout(`fixtures/build-${termination}`);
    state.runCommandWithTimeout.mockResolvedValueOnce({
      ...successfulBuild,
      code: null,
      signal: termination === "signal" ? "SIGTERM" : null,
      killed: true,
      termination,
    });

    await expectBuildFailure(root, message);
  });

  it("does not launch a build after its signal has already been canceled", async () => {
    root = sourceCheckout("fixtures/build-pre-aborted");
    const controller = new AbortController();
    controller.abort();

    await expect(
      ensureControlUiAssetsBuilt(undefined, { root, signal: controller.signal }),
    ).resolves.toEqual(buildFailure("Control UI build canceled."));
    expect(state.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it.each([
    ["index", "", (dir: string) => `${uiIndex(dir)} is still missing.`],
    [
      "startup asset",
      '<html><script src="./assets/main.js"></script></html>',
      () => "startup asset assets/main.js is missing.",
    ],
  ] as const)("rejects a successful build missing its %s", async (_name, html, issue) => {
    root = sourceCheckout("fixtures/build-incomplete");
    state.runCommandWithTimeout.mockImplementationOnce(async () => {
      if (html) {
        setFile(uiIndex(root), html);
      }
      return successfulBuild;
    });
    await expectBuildFailure(root, `Control UI build completed but ${issue(root)}`);
  });

  it("resolves control-ui root from override file or directory", () => {
    const uiDir = path.join(root, "dist", "control-ui");
    const indexPath = path.join(uiDir, "index.html");

    setFile(indexPath, "<html></html>\n");

    expect(resolveControlUiRootOverrideSync(uiDir)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(indexPath)).toBe(uiDir);
    expect(resolveControlUiRootOverrideSync(path.join(uiDir, "missing.html"))).toBeNull();
  });

  it("resolves control-ui root for dist bundle argv1 and moduleUrl candidates", () => {
    const pkgRoot = abs("fixtures/openclaw-bundle");
    vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockReturnValueOnce(pkgRoot);

    const uiDir = path.join(pkgRoot, "dist", "control-ui");
    setFile(path.join(uiDir, "index.html"), "<html></html>\n");

    expect(resolveControlUiRootSync({ argv1: path.join(pkgRoot, "dist", "bundle.js") })).toBe(
      uiDir,
    );

    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "bundle.js")).toString();
    expect(resolveControlUiRootSync({ moduleUrl })).toBe(uiDir);
  });

  it("preserves symlinked launcher discovery precedence with wrapper assets", async () => {
    const pkgRoot = abs("fixtures/bun-global/openclaw");
    const wrapperArgv1 = abs("fixtures/bin/openclaw");
    const realEntrypoint = path.join(pkgRoot, "dist", "index.js");
    const targetUi = path.join(pkgRoot, "dist", "control-ui");
    const wrapperUi = path.join(path.dirname(wrapperArgv1), "control-ui");
    const cwd = abs("fixtures/cwd");
    const cwdUi = path.join(cwd, "dist", "control-ui");

    setFile(realEntrypoint);
    fs.mkdirSync(path.dirname(wrapperArgv1), { recursive: true });
    fs.symlinkSync(realEntrypoint, wrapperArgv1, "file");
    setFile(path.join(cwdUi, "index.html"));
    setFile(path.join(targetUi, "index.html"));
    setFile(path.join(wrapperUi, "index.html"));

    expect(
      resolveControlUiRootSync({
        argv1: wrapperArgv1,
        cwd,
        execPath: abs("fixtures/runtime/node"),
      }),
    ).toBe(wrapperUi);
  });

  it("does not treat fallback roots as package-proven", () => {
    const pkgRoot = abs("fixtures/openclaw-package-root");
    const fallbackRoot = abs("fixtures/fallback-root/dist/control-ui");
    setFile(path.join(fallbackRoot, "index.html"), "<html></html>\n");
    vi.mocked(openclawRoot.resolveOpenClawPackageRootSync).mockReturnValueOnce(pkgRoot);

    expect(
      isPackageProvenControlUiRootSync(fallbackRoot, { cwd: abs("fixtures/fallback-root") }),
    ).toBe(false);
  });
});
