import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL_UI_PERFORMANCE_BUDGETS,
  collectControlUiPerformanceMetrics,
  evaluateControlUiPerformanceBudgets,
  extractControlUiStartupAssetPaths,
  formatControlUiPerformanceReport,
  runControlUiPerformanceCheck,
} from "../../scripts/check-control-ui-performance.mts";

const tempDirs: string[] = [];
const preparedScripts = new Map<string, string | Uint8Array>();
const tsxImport = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const baselineUpdateCommand =
  'node --import ./scripts/tsx.mjs scripts/check-control-ui-performance.mts --update-baseline --reason "<reason>"';
const startupHtml =
  '<script type="module" src="./assets/index-a.js"></script>\n<link rel="stylesheet" href="./assets/index-c.css">\n';
const readBaseline = (configDir: string) =>
  JSON.parse(
    fs.readFileSync(path.join(configDir, "control-ui-startup-budget-baseline.json"), "utf8"),
  );

function writeAssetAt(assetsDir: string, file: string, raw: number, gzip: number, brotli: number) {
  const assetPath = path.join(assetsDir, file);
  for (const [suffix, bytes] of [
    ["", raw],
    [".gz", gzip],
    [".br", brotli],
  ] as const) {
    fs.writeFileSync(`${assetPath}${suffix}`, Buffer.alloc(bytes));
  }
}
const preload = (file: string) => `<link rel="modulepreload" href="./assets/${file}">`;
const routeTemplate = (route: string, links: string[]) =>
  `<template data-openclaw-route-preloads="${route}">${links.join("")}</template>`;
function expectReportText(report: string, ...parts: string[]) {
  for (const part of parts) {
    expect(report).toContain(part);
  }
}

function runControlUiPerformanceCli(
  scriptPath: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTIONS: "",
    GITHUB_STEP_SUMMARY: "",
    ...extraEnv,
  };
  delete env.TSX_DISABLE_CACHE;
  return spawnSync(process.execPath, [fs.realpathSync(scriptPath), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function createDistFixture() {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-performance-"));
  const assetsDir = path.join(distDir, "assets");
  fs.mkdirSync(assetsDir);
  tempDirs.push(distDir);
  const writeAsset = (file: string, raw: number, gzip: number, brotli: number) =>
    writeAssetAt(assetsDir, file, raw, gzip, brotli);
  const writeHtml = (html = startupHtml) =>
    fs.writeFileSync(path.join(distDir, "index.html"), html);
  return { distDir, writeAsset, writeHtml };
}

function createStartupFixture() {
  const fixture = createDistFixture();
  fixture.writeHtml();
  fixture.writeAsset("index-a.js", 100, 40, 30);
  fixture.writeAsset("index-c.css", 50, 15, 12);
  return fixture;
}

function createCliFixture(startupCssGzipBytes = 15, deferredCssGzipBytes = 15) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-control-ui-budget-cli-"));
  tempDirs.push(rootDir);
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}\n');
  const scriptsDir = path.join(rootDir, "scripts");
  const scriptLibDir = path.join(scriptsDir, "lib");
  const configDir = path.join(rootDir, "config");
  const gatewayDir = path.join(rootDir, "src/gateway");
  const distDir = path.join(rootDir, "dist/control-ui");
  const assetsDir = path.join(distDir, "assets");
  for (const dir of [scriptLibDir, configDir, gatewayDir, assetsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const scriptPath = path.join(scriptsDir, "check-control-ui-performance.mts");
  fs.copyFileSync(path.resolve("scripts/check-control-ui-performance.mts"), scriptPath);
  fs.copyFileSync(
    path.resolve("src/gateway/control-ui-route-preloads.ts"),
    path.join(gatewayDir, "control-ui-route-preloads.ts"),
  );
  for (const file of [
    "check-limits.mts",
    "control-ui-i18n-config.ts",
    "control-ui-i18n-config.json",
    "record-shared.mjs",
    "regexp.mjs",
  ]) {
    fs.copyFileSync(path.resolve("scripts/lib", file), path.join(scriptLibDir, file));
  }
  fs.writeFileSync(
    path.join(scriptsDir, "tsx.mjs"),
    `await import(${JSON.stringify(tsxImport)});\n`,
  );
  fs.writeFileSync(path.join(distDir, "index.html"), startupHtml);
  for (const [file, raw, gzip, brotli] of [
    ["index-a.js", 100, 65, 50],
    ["index-c.css", 50, startupCssGzipBytes, 12],
    ["lazy-d.css", 50, deferredCssGzipBytes, 12],
  ] as const) {
    writeAssetAt(assetsDir, file, raw, gzip, brotli);
  }
  fs.writeFileSync(
    path.join(configDir, "control-ui-startup-budget-baseline.json"),
    JSON.stringify(startupBaseline(65)),
  );
  for (const [relative, contents] of preparedScripts) {
    const output = path.join(rootDir, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, contents);
  }
  if (preparedScripts.size > 0) {
    fs.copyFileSync(path.join(scriptsDir, "check-control-ui-performance.js"), scriptPath);
  }
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    runControlUiPerformanceCli(scriptPath, args, rootDir, env);
  return { rootDir, scriptPath, configDir, distDir, run };
}

function jsonCli(
  fixture: ReturnType<typeof createCliFixture>,
  args: string[] = [],
  exitCode = 0,
  env: NodeJS.ProcessEnv = {},
) {
  const result = fixture.run(["--json", ...args], env);
  expect(result.status, result.stderr).toBe(exitCode);
  return JSON.parse(result.stdout);
}

beforeAll(async () => {
  const { rootDir } = createCliFixture();
  const { bundles } = await build({
    config: false,
    cwd: rootDir,
    root: rootDir,
    entry: ["scripts/check-control-ui-performance.mts"],
    outDir: rootDir,
    unbundle: true,
    format: "esm",
    platform: "node",
    dts: false,
    clean: false,
    write: false,
    treeshake: false,
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    logLevel: "silent",
  });
  for (const bundle of bundles) {
    for (const output of bundle.chunks) {
      preparedScripts.set(output.fileName, output.type === "chunk" ? output.code : output.source);
    }
    await bundle[Symbol.asyncDispose]();
  }
});

const looseBudgets = {
  startupJsRequests: 10,
  chatBootJsRequests: 35,
  newBootJsRequests: 35,
  chatBootJsGzipBytes: 100_000,
  newBootJsGzipBytes: 100_000,
  startupCssRequests: 10,
  startupJsGzipBytes: 100_000,
  startupCssGzipBytes: 100_000,
  largestJsGzipBytes: 100_000,
  largestCssGzipBytes: 100_000,
};

function startupBaseline(startupJsGzipBytes: number) {
  return {
    startupJsGzipBytes,
    reason: "test baseline",
    updatedAt: "2026-07-22",
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("Control UI performance budgets", () => {
  it("extracts startup assets across relative and base-prefixed URLs", () => {
    expect(
      extractControlUiStartupAssetPaths(`
        <script type="module" src="./assets/index-abc.js?build=1"></script>
        <link rel="modulepreload" href="/control/assets/runtime-def.js">
        <link rel="stylesheet" href="./assets/index-abc.css#theme">
        <script data-src="./assets/deferred.js"></script>
        <link rel="manifest" href="./manifest.webmanifest">
      `),
    ).toEqual(["assets/index-abc.css", "assets/index-abc.js", "assets/runtime-def.js"]);
  });

  it("counts route boot preloads once without changing the initial-entry budget", () => {
    const { distDir, writeAsset, writeHtml } = createDistFixture();
    writeHtml(
      startupHtml +
        preload("runtime-b.js") +
        routeTemplate("chat", [
          preload("runtime-b.js"),
          preload("chat-d.js"),
          '<link rel="stylesheet" href="./assets/chat-e.css">',
        ]) +
        routeTemplate("new", [preload("new-f.js")]),
    );
    writeAsset("index-a.js", 100, 40, 30);
    writeAsset("runtime-b.js", 80, 25, 20);
    writeAsset("chat-d.js", 200, 70, 55);
    writeAsset("index-c.css", 50, 15, 12);
    writeAsset("chat-e.css", 25, 10, 8);
    writeAsset("new-f.js", 150, 60, 45);
    writeAsset("lazy-g.js", 300, 90, 65);
    fs.writeFileSync(path.join(distDir, "assets/art.webp"), Buffer.alloc(17));

    const metrics = collectControlUiPerformanceMetrics(distDir);

    expect(metrics).toMatchObject({
      startup: {
        js: { requests: 2, rawBytes: 180, gzipBytes: 65, brotliBytes: 50 },
        css: { gzipBytes: 15 },
      },
      routeBoot: {
        chat: {
          js: { requests: 3, rawBytes: 380, gzipBytes: 135, brotliBytes: 105 },
          css: { requests: 2, rawBytes: 75, gzipBytes: 25, brotliBytes: 20 },
        },
        new: {
          js: { requests: 3, rawBytes: 330, gzipBytes: 125, brotliBytes: 95 },
          css: { requests: 1, rawBytes: 50, gzipBytes: 15, brotliBytes: 12 },
        },
      },
      total: { js: { requests: 5, rawBytes: 830, gzipBytes: 285 } },
      largest: { js: { file: "assets/lazy-g.js" }, css: { file: "assets/index-c.css" } },
    });
    const report = formatControlUiPerformanceReport(metrics);
    expectReportText(
      report,
      "startup CSS: 1 request",
      "chat boot JS: 3 requests, 135 B gzip",
      "70 B beyond initial-entry JS",
      "new boot JS: 3 requests, 125 B gzip",
    );
    writeAsset("chat-d.js", 180, 50, 40);
    const smaller = collectControlUiPerformanceMetrics(distDir);
    expect(formatControlUiPerformanceReport(smaller, looseBudgets, null, 512, metrics)).toContain(
      "chat boot JS gzip vs base: 135 B -> 115 B (-20 B); requests 3 -> 3",
    );
  });

  it("returns actionable violations and includes them in the report", () => {
    const { distDir } = createStartupFixture();
    const metrics = collectControlUiPerformanceMetrics(distDir);
    const budgets = {
      ...looseBudgets,
      startupJsRequests: 0,
      startupCssRequests: 1,
      startupJsGzipBytes: 30,
      startupCssGzipBytes: 20,
      largestJsGzipBytes: 35,
      largestCssGzipBytes: 20,
    };

    expect(
      evaluateControlUiPerformanceBudgets(metrics, budgets).map((entry) => entry.metric),
    ).toEqual(["startup JS requests", "startup JS gzip", "largest JS gzip"]);
    expectReportText(
      formatControlUiPerformanceReport(metrics, budgets),
      "startup JS gzip: 40 B exceeds 30 B",
      "route boot accounting: unavailable (build has no route preload templates)",
    );
    expect(metrics.routeBoot).toBeNull();
  });

  it("rejects the renderer in route boot preloads", () => {
    const { distDir, writeAsset, writeHtml } = createStartupFixture();
    writeHtml(startupHtml + routeTemplate("chat", [preload("mermaid.min-a.js")]));
    writeAsset("lazy-b.js", 200, 70, 55);
    writeAsset("mermaid.min-a.js", 200, 200_000, 100);
    const metrics = collectControlUiPerformanceMetrics(distDir);
    expect(evaluateControlUiPerformanceBudgets(metrics).map((entry) => entry.metric)).toEqual([
      "startup Mermaid JS assets",
    ]);
    expect(metrics.total.js.gzipBytes).toBe(200_110);
    expect(metrics.largest.js.file).toBe("assets/lazy-b.js");
    expect(formatControlUiPerformanceReport(metrics)).toContain("isolated Mermaid JS:");
  });

  it("retains the ordinary chunk cap beside locale pairs", () => {
    const { distDir, writeAsset } = createStartupFixture();
    writeAsset("lazy-b.js", 200, 215 * 1024 + 1, 55);
    writeAsset("ru-a.js", 200, 100_000, 100);
    writeAsset("locale-config-hints-ru-a.js", 200, 100_000, 100);
    const metrics = collectControlUiPerformanceMetrics(distDir);
    expect(evaluateControlUiPerformanceBudgets(metrics).map((entry) => entry.metric)).toEqual([
      "largest JS gzip",
    ]);
    expect(metrics.total.js.gzipBytes).toBe(420_201);
    expect(metrics.largest.js.file).toBe("assets/lazy-b.js");
    expect(formatControlUiPerformanceReport(metrics)).toContain("locale catalog JS:");
  });

  it("reports a 17-byte startup CSS target excess without failing the check", () => {
    const report = jsonCli(createCliFixture(46_097));
    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([expect.stringContaining("CSS")]);
    expectReportText(report.report, "46097 B", "5103 B");
  });

  it.each<[string, number, number, number, number, string | null]>([
    ["startup growth below 1.5 KiB", 47_615, 46_080, 50_000, 50_000, null],
    ["startup growth at 1.5 KiB", 47_616, 46_080, 50_000, 50_000, "startup CSS"],
    ["deferred growth below 1.5 KiB", 46_080, 46_080, 52_000, 50_465, null],
    ["deferred growth at 1.5 KiB", 46_080, 46_080, 52_000, 50_464, "largest CSS"],
    ["startup at the hard cap", 51_200, 51_200, 50_000, 50_000, null],
    ["startup above the hard cap", 51_201, 51_201, 50_000, 50_000, "startup CSS"],
    ["deferred at the hard cap", 46_080, 46_080, 53_400, 53_400, null],
    ["deferred above the hard cap", 46_080, 46_080, 53_401, 53_401, "largest CSS"],
  ])("checks %s against built base assets", (_name, css, baseCss, lazy, baseLazy, metric) => {
    const current = createCliFixture(css, lazy);
    const base = createCliFixture(baseCss, baseLazy);
    const report = jsonCli(current, ["--base-dist", base.distDir], metric ? 1 : 0);
    expect(report.baseMetrics.startup.css.gzipBytes).toBe(baseCss);
    expect(report.baseMetrics.largest.css.gzipBytes).toBe(Math.max(baseCss, baseLazy));
    expect(report.violations).toEqual(
      metric ? [expect.objectContaining({ metric: expect.stringContaining(metric) })] : [],
    );
    expect(report.report).toContain(`${css} B`);
  });

  it.each(["size", "baseline"])(
    "warns about %s growth in Actions while local CI stays strict",
    (kind) => {
      const { rootDir, run, configDir } = createCliFixture(kind === "size" ? 51_201 : 15);
      if (kind === "baseline") {
        fs.writeFileSync(
          path.join(configDir, "control-ui-startup-budget-baseline.json"),
          JSON.stringify(startupBaseline(CONTROL_UI_PERFORMANCE_BUDGETS.startupJsGzipBytes + 1)),
        );
      }
      const local = run(["--json"], { CI: "1" });
      const summaryPath = path.join(rootDir, "summary.md");
      const actions = run(["--json"], {
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summaryPath,
      });

      expect(local.status, local.stderr).toBe(1);
      expect(actions.status, actions.stderr).toBe(0);
      expect(JSON.parse(actions.stdout).violations).toEqual(JSON.parse(local.stdout).violations);
      expect(actions.stderr).toContain("::warning file=");
      expect(fs.readFileSync(summaryPath, "utf8")).toContain("Control UI asset budget");
    },
  );

  it.each(["chat", "new"] as const)("enforces the %s boot request limit in Actions", (route) => {
    const fixture = createCliFixture();
    const { distDir } = fixture;
    const limit = CONTROL_UI_PERFORMANCE_BUDGETS[`${route}BootJsRequests`];
    const links = Array.from({ length: limit }, (_, index) => {
      const file = `route-${index}.js`;
      writeAssetAt(path.join(distDir, "assets"), file, 1, 1, 1);
      return preload(file);
    });
    const indexPath = path.join(distDir, "index.html");
    const initial = fs.readFileSync(indexPath, "utf8");
    const writeRoute = (count: number) =>
      fs.writeFileSync(indexPath, initial + routeTemplate(route, links.slice(0, count)));
    writeRoute(limit);
    const actions = { GITHUB_ACTIONS: "true" };
    expect(jsonCli(fixture, [], 1, actions).violations).toEqual([
      expect.objectContaining({ metric: `${route} boot JS requests`, actual: limit + 1, limit }),
    ]);
    jsonCli(fixture, ["--report-only"], 0, actions);
    writeRoute(limit - 1);
    expect(jsonCli(fixture, [], 0, actions).violations).toEqual([]);
  });

  it.each(["chat", "new"] as const)("enforces the %s boot byte limit in Actions", (route) => {
    const fixture = createCliFixture();
    const { distDir } = fixture;
    const limit = CONTROL_UI_PERFORMANCE_BUDGETS[`${route}BootJsGzipBytes`];
    const initialBytes = collectControlUiPerformanceMetrics(distDir).startup.js.gzipBytes;
    const links: string[] = [];
    let remaining = limit - initialBytes;
    for (let index = 0; remaining > 0; index++) {
      const file = `route-${index}.js`;
      const bytes = Math.min(200_000, remaining);
      remaining -= bytes;
      writeAssetAt(path.join(distDir, "assets"), file, bytes, bytes, bytes);
      links.push(preload(file));
    }
    const indexPath = path.join(distDir, "index.html");
    fs.appendFileSync(indexPath, routeTemplate(route, links));
    const actions = { GITHUB_ACTIONS: "true" };
    expect(jsonCli(fixture, [], 0, actions).violations).toEqual([]);

    fs.appendFileSync(path.join(distDir, "assets/route-0.js.gz"), "x");
    expect(jsonCli(fixture, [], 1, actions).violations).toEqual([
      expect.objectContaining({ metric: `${route} boot JS gzip`, actual: limit + 1, limit }),
    ]);
    jsonCli(fixture, ["--report-only"], 0, actions);
  });

  it("fails closed when the startup baseline is malformed", () => {
    const { distDir } = createStartupFixture();
    const baselinePath = path.join(distDir, "baseline.json");
    fs.writeFileSync(baselinePath, '{"startupJsGzipBytes":"not-a-number"}\n');

    expect(() => runControlUiPerformanceCheck(distDir, looseBudgets, baselinePath)).toThrow(
      /Cannot read Control UI startup budget baseline .*--update-baseline/u,
    );
    expect(() => runControlUiPerformanceCheck(distDir, looseBudgets, baselinePath)).toThrow(
      `Regenerate it with ${baselineUpdateCommand}.`,
    );
  });

  it("reports a startup baseline above the configured cap as a budget violation", () => {
    const { distDir } = createStartupFixture();
    const baselinePath = path.join(distDir, "baseline.json");
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(startupBaseline(CONTROL_UI_PERFORMANCE_BUDGETS.startupJsGzipBytes + 1)),
    );

    expect(runControlUiPerformanceCheck(distDir, undefined, baselinePath).violations).toEqual([
      expect.objectContaining({ metric: "startup JS gzip baseline" }),
    ]);
  });

  it("updates the baseline from generated or explicitly measured metrics", () => {
    const { run, configDir, distDir } = createCliFixture();
    const update = (args: string[] = []) => {
      const result = run(["--update-baseline", ...args]);
      expect(result.status, result.stderr).toBe(0);
      return readBaseline(configDir);
    };
    expect(update()).toEqual({
      startupJsGzipBytes: 65,
      reason: "manual baseline update",
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
    });

    expect(update(["--reason", "fixture update"])).toMatchObject({
      startupJsGzipBytes: 65,
      reason: "fixture update",
    });

    fs.rmSync(distDir, { recursive: true });
    expect(update(["--startup-js-bytes", "321", "--reason", "explicit measurement"])).toMatchObject(
      {
        startupJsGzipBytes: 321,
        reason: "explicit measurement",
      },
    );

    const beyondRatchetResult = run(["--update-baseline", "--startup-js-bytes", "4418"]);
    expect(beyondRatchetResult.status).toBe(1);
    expect(beyondRatchetResult.stderr).toContain(
      "4418 B differs from current baseline 321 B by 4097 B, exceeding the 4096 B ratchet",
    );
    expect(readBaseline(configDir)).toMatchObject({
      startupJsGzipBytes: 321,
      reason: "explicit measurement",
    });
  });

  it.each([
    { name: "lowering", baseline: JSON.stringify(startupBaseline(5_000)), exitCode: 0 },
    { name: "malformed", baseline: '{"startupJsGzipBytes":"not-a-number"}\n', exitCode: 1 },
    { name: "missing", baseline: null, exitCode: 1 },
  ])("executes the $name baseline hint with the canonical preload", ({ baseline, exitCode }) => {
    const { rootDir, run, configDir } = createCliFixture();
    const baselinePath = path.join(configDir, "control-ui-startup-budget-baseline.json");
    if (baseline === null) {
      fs.unlinkSync(baselinePath);
    } else {
      fs.writeFileSync(baselinePath, baseline);
    }
    const report = run();
    expect(report.status, report.stderr).toBe(exitCode);
    const output = exitCode === 0 ? report.stdout : report.stderr;
    const command = output.match(/node --import [^\r\n]*?--reason "<reason>"/u)?.[0];
    // Never spawn an old raw-tsx hint: it could access the host's shared cache.
    expect(command).toBe(baselineUpdateCommand);

    const reason = "fixture hint update";
    const args = command!
      .slice("node ".length)
      .split(" ")
      .map((arg) => (arg === '"<reason>"' ? reason : arg));
    const env = { ...process.env };
    delete env.TSX_DISABLE_CACHE;
    const beforeDate = new Date().toISOString().slice(0, 10);
    const update = spawnSync(process.execPath, args, {
      cwd: rootDir,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(update.status, update.stderr).toBe(0);
    expect(update.stdout).toBe(
      `Updated config/control-ui-startup-budget-baseline.json to 65 B (${reason}).\n`,
    );
    const expectedBytes = [beforeDate, new Date().toISOString().slice(0, 10)].map(
      (updatedAt) => `${JSON.stringify({ startupJsGzipBytes: 65, reason, updatedAt }, null, 2)}\n`,
    );
    expect(expectedBytes).toContain(fs.readFileSync(baselinePath, "utf8"));
  });
});
