import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "tsdown";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL_UI_PERFORMANCE_BUDGETS,
  collectControlUiPerformanceMetrics as collectMetrics,
  evaluateControlUiPerformanceBudgets as evaluateBudgets,
  formatControlUiPerformanceReport as formatReport,
} from "../../scripts/check-control-ui-performance.mts";
import { prepareControlUiSettings } from "../../scripts/lib/prepare-control-ui-settings.mts";
import { extractControlUiStartupAssetPaths as extractStartupAssets } from "../../ui/config/control-ui-startup-assets.ts";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";

const tsxImport = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const performanceSources = [
  "scripts/check-control-ui-performance.mts",
  "ui/config/control-ui-startup-assets.ts",
  "src/gateway/control-ui-route-preloads.ts",
  "src/shared/non-packaged-plugin-dirs.ts",
  ...[
    "check-limits.mts",
    "control-ui-i18n-config.ts",
    "control-ui-i18n-config.json",
    "control-ui-module-attribution.mts",
    "control-ui-optional-assets.ts",
    "record-shared.mjs",
    "regexp.mjs",
  ].map((name) => `scripts/lib/${name}`),
].map((file): [string, string] => [file, fs.readFileSync(path.resolve(file), "utf8")]);
function compileFixture(root: string, entry: string[], options: Parameters<typeof build>[0] = {}) {
  return build({
    config: false,
    cwd: root,
    root,
    entry,
    outDir: root,
    unbundle: true,
    format: "esm",
    platform: "node",
    dts: false,
    clean: false,
    treeshake: false,
    deps: { neverBundle: ["pako", "@openclaw/fs-safe"] },
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    logLevel: "silent",
    ...options,
  });
}

describe("Control UI performance budgets", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const scriptName = "scripts/check-control-ui-performance.mts";
  const baselineName = "config/control-ui-startup-budget-baseline.json";
  const preparedFiles = new Map<string, string | Uint8Array>([
    ["package.json", '{"type":"module"}\n'],
    ["scripts/tsx.mjs", `await import(${JSON.stringify(tsxImport)});\n`],
    ...performanceSources,
  ]);
  const baselineUpdateCommand =
    'node --import ./scripts/tsx.mjs scripts/check-control-ui-performance.mts --update-baseline --reason "<reason>"';
  const startupHtml =
    '<script type="module" src="./assets/index-a.js"></script>\n<link rel="stylesheet" href="./assets/index-c.css">\n';
  const readBaseline = (baselinePath: string) => JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  function writeAssetAt(assetsDir: string, file: string, raw: number, gzip = raw, brotli = gzip) {
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

  function runNode(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_ACTIONS: "",
      GITHUB_STEP_SUMMARY: "",
      ...extraEnv,
    };
    delete env.TSX_DISABLE_CACHE;
    return spawnSync(process.execPath, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  function createDistFixture(distDir = tempDirs.make("openclaw-control-ui-performance-")) {
    const assetsDir = path.join(distDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const writeAsset = (file: string, raw: number, gzip = raw, brotli = gzip) =>
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
    const rootDir = tempDirs.make("openclaw-control-ui-budget-cli-");
    fs.mkdirSync(path.join(rootDir, "node_modules"));
    fs.symlinkSync(
      fs.realpathSync(path.resolve("ui/node_modules/pako")),
      path.join(rootDir, "node_modules/pako"),
      "junction",
    );
    const baselinePath = path.join(rootDir, baselineName);
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    const { distDir, writeAsset, writeHtml } = createDistFixture(
      path.join(rootDir, "dist/control-ui"),
    );
    writeHtml();
    for (const [file, raw, gzip, brotli] of [
      ["index-a.js", 100, 65, 50],
      ["index-c.css", 50, startupCssGzipBytes, 12],
      ["lazy-d.css", 50, deferredCssGzipBytes, 12],
    ] as const) {
      writeAsset(file, raw, gzip, brotli);
    }
    fs.writeFileSync(baselinePath, JSON.stringify(startupBaseline(65)));
    for (const [relative, contents] of preparedFiles) {
      const output = path.join(rootDir, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, contents);
    }
    const scriptPath = path.join(rootDir, scriptName);
    const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
      runNode([fs.realpathSync(scriptPath), ...args], rootDir, env);
    const routeAssets = (route: string | null, sizes: number[], count = sizes.length) => {
      const links = sizes
        .map((bytes, index) => {
          const name = `route-${index}.js`;
          writeAsset(name, bytes);
          return preload(name);
        })
        .slice(0, count);
      writeHtml(startupHtml + (route ? routeTemplate(route, links) : links.join("")));
    };
    return { rootDir, baselinePath, distDir, run, writeAsset, writeHtml, routeAssets };
  }

  const chunks = (bytes: number) =>
    Array.from({ length: Math.ceil(bytes / 200_000) }, (_, index) =>
      Math.min(200_000, bytes - index * 200_000),
    );
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

  it("attributes startup without requiring route preload templates", () => {
    const fixture = createCliFixture();
    const result = jsonCli(fixture, ["--module-attribution"]);
    expect(result.moduleAttribution.startup).toMatchObject({
      shippedGzipBytes: 65,
      missingSourceMaps: ["assets/index-a.js"],
    });
    expect(Object.keys(result.moduleAttribution)).toEqual(["startup"]);
  });

  beforeAll(async () => {
    const { rootDir } = createCliFixture();
    const { bundles } = await compileFixture(rootDir, [scriptName], { write: false });
    for (const bundle of bundles) {
      for (const output of bundle.chunks) {
        const content = output.type === "chunk" ? output.code : output.source;
        preparedFiles.set(output.fileName, content);
        if (output.fileName === "scripts/check-control-ui-performance.js") {
          preparedFiles.set(scriptName, content);
        }
      }
      await bundle[Symbol.asyncDispose]();
    }
  });

  const startupBaseline = (startupJsGzipBytes: number) => ({
    startupJsGzipBytes,
    reason: "test baseline",
    updatedAt: "2026-07-22",
  });

  it("extracts startup assets across relative and base-prefixed URLs", () => {
    expect(
      extractStartupAssets(`
        <script type="module" src="./assets/index-abc.js?build=1"></script>
        <link rel="modulepreload" href="/control/assets/runtime-def.js">
        <link rel="stylesheet" href="./assets/index-abc.css#theme">
        <script data-src="./assets/deferred.js"></script>
        <link rel="manifest" href="./manifest.webmanifest">
      `),
    ).toEqual(["assets/index-abc.css", "assets/index-abc.js", "assets/runtime-def.js"]);
  });

  it("counts identity bytes for each missing compression sidecar", () => {
    const { distDir } = createStartupFixture();
    fs.unlinkSync(path.join(distDir, "assets/index-a.js.gz"));
    fs.unlinkSync(path.join(distDir, "assets/index-c.css.br"));
    expect(collectMetrics(distDir).startup).toMatchObject({
      js: { rawBytes: 100, gzipBytes: 100, brotliBytes: 30 },
      css: { rawBytes: 50, gzipBytes: 15, brotliBytes: 50 },
    });
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

    const metrics = collectMetrics(distDir);

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
    const report = formatReport(metrics);
    expectReportText(
      report,
      "startup CSS: 1 request",
      "chat boot JS: 3 requests, 135 B gzip",
      "70 B beyond initial-entry JS",
      "new boot JS: 3 requests, 125 B gzip",
      "chat boot CSS: 2 requests, 25 B gzip (25 B)",
      "1 beyond initial-entry CSS; limit: 3 requests",
    );
    expect(
      evaluateBudgets(metrics, {
        ...CONTROL_UI_PERFORMANCE_BUDGETS,
        chatBootCssRequests: 1,
        newBootCssRequests: 0,
      }),
    ).toEqual([
      { metric: "chat boot CSS requests", actual: 2, limit: 1, unit: "count" },
      { metric: "new boot CSS requests", actual: 1, limit: 0, unit: "count" },
    ]);
    writeAsset("chat-d.js", 180, 50, 40);
    const smaller = collectMetrics(distDir);
    expect(formatReport(smaller, undefined, null, 512, metrics)).toContain(
      "chat boot JS gzip vs base: 135 B -> 115 B (-20 B); requests 3 -> 3",
    );
  });

  it("returns actionable custom-budget violations", () => {
    const { distDir } = createStartupFixture();
    const metrics = collectMetrics(distDir);
    const budgets = {
      ...CONTROL_UI_PERFORMANCE_BUDGETS,
      startupJsRequests: 0,
      startupJsGzipBytes: 30,
      largestJsGzipBytes: 35,
    };
    expect(evaluateBudgets(metrics, budgets).map((entry) => entry.metric)).toEqual([
      "startup JS requests",
      "startup JS gzip",
      "largest JS gzip",
    ]);
    expect(formatReport(metrics, budgets)).toContain("startup JS gzip: 40 B exceeds 30 B");
  });

  it("bounds stylesheet growth at the fixed CSS ceilings", () => {
    const { distDir, writeAsset } = createStartupFixture();
    const base = collectMetrics(distDir);
    const raw = CONTROL_UI_PERFORMANCE_BUDGETS.totalCssRawBytes - base.total.css.rawBytes;
    const gzip = CONTROL_UI_PERFORMANCE_BUDGETS.totalCssGzipBytes - base.total.css.gzipBytes;
    for (let index = 0; index < 6; index++) {
      writeAsset(
        "css-" + index + ".css",
        Math.floor(raw / 6) + (index < raw % 6 ? 1 : 0),
        Math.floor(gzip / 6) + (index < gzip % 6 ? 1 : 0),
      );
    }
    const accepted = collectMetrics(distDir);
    expect(evaluateBudgets(accepted, undefined, null, 512, base)).toEqual([]);
    writeAsset("overflow.css", 1, 1);
    expect(evaluateBudgets(collectMetrics(distDir), undefined, null, 512, base)).toEqual([
      expect.objectContaining({ metric: "total CSS gzip" }),
      expect.objectContaining({ metric: "total CSS raw" }),
    ]);
  });

  it("allows CSS consolidation but rejects total growth beyond fixed ceilings", () => {
    const { distDir, writeAsset } = createStartupFixture();
    writeAsset("shared.css", 4_000, 2_000);
    writeAsset("route.css", 4_000, 2_000);
    const base = collectMetrics(distDir);
    const budgets = {
      ...CONTROL_UI_PERFORMANCE_BUDGETS,
      totalCssGzipBytes: base.total.css.gzipBytes + 64,
      totalCssRawBytes: base.total.css.rawBytes + 64,
    };
    fs.unlinkSync(path.join(distDir, "assets/route.css"));
    writeAsset("shared.css", 8_000, 3_900);
    const consolidated = collectMetrics(distDir);
    expect(evaluateBudgets(consolidated, budgets, null, 512, base)).toEqual([]);
    expect(formatReport(consolidated, budgets, null, 512, base)).toContain(
      "total CSS gzip vs base: 4015 B -> 3915 B (-100 B; fixed ceiling 4079 B)",
    );
    writeAsset("shared.css", 8_000, 4_064);
    expect(evaluateBudgets(collectMetrics(distDir), budgets, null, 512, base)).toEqual([]);
    writeAsset("shared.css", 8_000, 4_065);
    expect(evaluateBudgets(collectMetrics(distDir), budgets, null, 512, base)).toEqual([
      { metric: "total CSS gzip", actual: 4080, limit: 4079, unit: "bytes" },
    ]);
    writeAsset("shared.css", 8_064, 3_900);
    const rawAtLimit = collectMetrics(distDir);
    expect(evaluateBudgets(rawAtLimit, budgets, null, 512, base)).toEqual([]);
    expect(formatReport(rawAtLimit, budgets, null, 512, base)).toContain(
      "total CSS raw vs base: 8050 B -> 8114 B (+64 B; fixed ceiling 8114 B)",
    );
    writeAsset("shared.css", 8_065, 3_900);
    expect(evaluateBudgets(collectMetrics(distDir), budgets, null, 512, base)).toEqual([
      { metric: "total CSS raw", actual: 8115, limit: 8114, unit: "bytes" },
    ]);
  });

  it("rejects the renderer in route boot preloads", () => {
    const { distDir, writeAsset, writeHtml } = createStartupFixture();
    writeHtml(startupHtml + routeTemplate("chat", [preload("mermaid.min-a.js")]));
    writeAsset("lazy-b.js", 200, 70, 55);
    writeAsset("mermaid.min-a.js", 200, 200_000, 100);
    const metrics = collectMetrics(distDir);
    expect(evaluateBudgets(metrics).map((entry) => entry.metric)).toEqual([
      "startup Mermaid JS assets",
    ]);
    expect(metrics.total.js.gzipBytes).toBe(200_110);
    expect(metrics.largest.js.file).toBe("assets/lazy-b.js");
    expect(formatReport(metrics)).toContain("isolated Mermaid JS:");
  });

  it("retains the ordinary chunk cap beside locale pairs", () => {
    const { distDir, writeAsset } = createStartupFixture();
    const cap = CONTROL_UI_PERFORMANCE_BUDGETS.largestJsGzipBytes;
    writeAsset("lazy-b.js", 200, cap + 1, 55);
    writeAsset("ru-a.js", 200, 100_000, 100);
    writeAsset("locale-config-hints-ru-a.js", 200, 100_000, 100);
    const metrics = collectMetrics(distDir);
    expect(evaluateBudgets(metrics).map((entry) => entry.metric)).toEqual(["largest JS gzip"]);
    expect(metrics.total.js.gzipBytes).toBe(cap + 200_041);
    expect(metrics.largest.js.file).toBe("assets/lazy-b.js");
    expect(formatReport(metrics)).toContain("locale catalog JS:");
  });

  it("reports a 17-byte startup CSS target excess without failing the check", () => {
    const report = jsonCli(createCliFixture(46_097));
    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([expect.stringContaining("CSS")]);
    expect(report.metrics.routeBoot).toBeNull();
    expectReportText(
      report.report,
      "46097 B",
      "5103 B",
      "route boot accounting: unavailable (build has no route preload templates)",
    );
  });

  const largestCssCap = CONTROL_UI_PERFORMANCE_BUDGETS.largestCssGzipBytes;
  it.each<[string, number, number, number, number, string | null]>([
    ["startup growth below 1.5 KiB with offset", 47_615, 46_080, 48_465, 50_000, null],
    ["startup growth at 1.5 KiB with offset", 47_616, 46_080, 48_464, 50_000, "startup CSS"],
    ["total growth within fixed ceiling", 46_080, 46_080, 52_000, 51_935, null],
    ["startup at the hard cap", 51_200, 51_200, 50_000, 50_000, null],
    ["startup newly above the hard cap", 51_201, 51_200, 50_000, 50_000, "startup CSS"],
    ["startup unchanged above the hard cap", 51_201, 51_201, 50_000, 50_000, null],
    ["deferred at the hard cap", 46_080, 46_080, largestCssCap, largestCssCap, null],
    [
      "deferred newly above the hard cap",
      46_080,
      46_080,
      largestCssCap + 1,
      largestCssCap,
      "largest CSS",
    ],
    [
      "deferred unchanged above the hard cap",
      46_080,
      46_080,
      largestCssCap + 1,
      largestCssCap + 1,
      null,
    ],
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

  it.each(["size", "baseline"])("rejects %s violations in Actions and local CI", (kind) => {
    const { rootDir, run, baselinePath } = createCliFixture(kind === "size" ? 51_201 : 15);
    if (kind === "baseline") {
      fs.writeFileSync(
        baselinePath,
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
    expect(actions.status, actions.stderr).toBe(1);
    expect(JSON.parse(actions.stdout).violations).toEqual(JSON.parse(local.stdout).violations);
    expect(JSON.parse(local.stdout).violations).toEqual([
      expect.objectContaining({
        metric: kind === "baseline" ? "startup JS gzip baseline" : "startup CSS gzip",
      }),
    ]);
    expect(actions.stderr).toContain("::warning file=");
    expect(fs.readFileSync(summaryPath, "utf8")).toContain("Control UI asset budget");
  });

  it.each(["startup", "chat", "new", "locale"] as const)(
    "allows only build variance while the base %s bytes exceed the cap",
    (area) => {
      const base = createCliFixture();
      const head = createCliFixture();
      const cap =
        area === "locale"
          ? 307_200
          : area === "startup"
            ? 641
            : CONTROL_UI_PERFORMANCE_BUDGETS[`${area}BootJsGzipBytes`];
      const writeBytes = (fixture: ReturnType<typeof createCliFixture>, bytes: number) => {
        if (area === "startup") {
          fixture.writeAsset("index-a.js", bytes);
        } else if (area === "locale") {
          fixture.writeAsset("ru-a.js", bytes);
        } else {
          fixture.routeAssets(area, chunks(bytes - 65));
        }
      };
      writeBytes(base, cap + 100);
      for (const growth of [-1, 0, 64, 65]) {
        writeBytes(head, cap + 100 + growth);
        const result = jsonCli(head, ["--base-dist", base.distDir], growth > 64 ? 1 : 0);
        if (growth > 64) {
          expect(result.report).toContain("base already exceeds the cap");
          expect(result.report).toContain("no growth beyond 64 B build variance");
        } else {
          expect(result.violations).toEqual([]);
        }
      }
    },
  );

  it("checks an over-budget locale independently when the largest locale shrinks", () => {
    const base = createCliFixture();
    const head = createCliFixture();
    for (const [fixture, ru, de] of [
      [base, 310_000, 320_000],
      [head, 310_065, 315_000],
    ] as const) {
      fixture.writeAsset("ru-a.js", ru);
      fixture.writeAsset("de-a.js", de);
    }
    const result = jsonCli(head, ["--base-dist", base.distDir], 1);
    expect(result.violations).toEqual([
      expect.objectContaining({
        metric: "ru locale catalog pair JS gzip",
        actual: 310_065,
        limit: 310_064,
      }),
    ]);
  });

  it("allows no request-count growth when the base is already over budget", () => {
    const base = createCliFixture();
    const head = createCliFixture();
    const writeRequests = (fixture: ReturnType<typeof createCliFixture>, count: number) => {
      fixture.routeAssets(null, Array<number>(count - 1).fill(1));
    };
    writeRequests(base, 10);
    for (const count of [9, 10, 11]) {
      writeRequests(head, count);
      const result = jsonCli(head, ["--base-dist", base.distDir], count > 10 ? 1 : 0);
      expect(result.violations).toEqual(
        count > 10
          ? [expect.objectContaining({ metric: "startup JS requests", actual: 11, limit: 10 })]
          : [],
      );
    }
  });

  it.each([
    ["chat", "requests"],
    ["new", "requests"],
    ["chat", "gzip"],
    ["new", "gzip"],
  ] as const)("enforces the %s boot %s limit in Actions", (route, metric) => {
    const fixture = createCliFixture();
    const { distDir } = fixture;
    const requests = metric === "requests";
    const limit =
      CONTROL_UI_PERFORMANCE_BUDGETS[`${route}${requests ? "BootJsRequests" : "BootJsGzipBytes"}`];
    const sizes = requests
      ? Array<number>(limit).fill(1)
      : chunks(limit - collectMetrics(distDir).startup.js.gzipBytes);
    const writeRoute = (count: number) => fixture.routeAssets(route, sizes, count);
    writeRoute(sizes.length - Number(requests));
    const actions = { GITHUB_ACTIONS: "true" };
    expect(jsonCli(fixture, [], 0, actions).violations).toEqual([]);
    if (requests) {
      writeRoute(sizes.length);
    } else {
      fs.appendFileSync(path.join(distDir, "assets/route-0.js.gz"), "x");
    }
    expect(jsonCli(fixture, [], 1, actions).violations).toEqual([
      expect.objectContaining({ metric: `${route} boot JS ${metric}`, actual: limit + 1, limit }),
    ]);
    jsonCli(fixture, ["--report-only"], 0, actions);
  });

  it("enforces each locale pair cap in Actions and reports exact headroom", () => {
    const fixture = createCliFixture();
    const assetsDir = path.join(fixture.distDir, "assets");
    fixture.writeAsset("ru-a.js", 100_000, 100_000, 100);
    fixture.writeAsset("locale-config-hints-ru-a.js", 207_200, 207_200, 100);
    fixture.writeAsset("de-a.js", 130_000, 130_000, 100);
    fixture.writeAsset("locale-config-hints-de-a.js", 177_200, 177_200, 100);
    const actions = { GITHUB_ACTIONS: "true" };
    const passing = jsonCli(fixture, [], 0, actions);
    expect(passing.violations).toEqual([]);
    expectReportText(
      passing.report,
      "ru: 307200 B gzip (base 100000 B + config hints 207200 B; cap 307200 B; headroom 0 B)",
      "de: 307200 B gzip (base 130000 B + config hints 177200 B; cap 307200 B; headroom 0 B)",
    );

    for (const locale of ["ru", "de"]) {
      const gzipPath = path.join(assetsDir, `${locale}-a.js.gz`);
      const originalBytes = fs.statSync(gzipPath).size;
      fs.appendFileSync(gzipPath, "x");
      const failing = jsonCli(fixture, [], 1, actions);
      expect(failing.violations).toEqual([
        {
          metric: `${locale} locale catalog pair JS gzip`,
          actual: 307_201,
          limit: 307_200,
          unit: "bytes",
        },
      ]);
      expect(failing.report).toContain(`${locale}: 307201 B gzip`);
      expect(failing.report).toContain("headroom -1 B");
      jsonCli(fixture, ["--report-only"], 0, actions);
      fs.truncateSync(gzipPath, originalBytes);
    }
  });

  it.each([
    { baselineBytes: 315_881, limit: 316_457 },
    { baselineBytes: 311_544, limit: 312_120 },
  ])(
    "enforces unchanged startup allowances for a $baselineBytes B baseline",
    ({ baselineBytes, limit }) => {
      const fixture = createCliFixture();
      // Synthetic assets and their baseline must not depend on the live build ratchet.
      fs.writeFileSync(fixture.baselinePath, JSON.stringify(startupBaseline(baselineBytes)));
      const assetsDir = path.join(fixture.distDir, "assets");
      writeAssetAt(assetsDir, "index-a.js", 200_000, 200_000, 200_000);
      writeAssetAt(assetsDir, "runtime-b.js", limit - 200_000);
      fs.appendFileSync(path.join(fixture.distDir, "index.html"), preload("runtime-b.js"));

      expect(jsonCli(fixture)).toMatchObject({
        budgets: { startupJsGzipBytes: 325_131 },
        startupBudgetBaseline: { startupJsGzipBytes: baselineBytes },
        startupJsTolerance: 512,
        startupJsBuildVariance: 64,
        metrics: { startup: { js: { gzipBytes: limit, requests: 2 } } },
        violations: [],
      });

      fs.appendFileSync(path.join(assetsDir, "index-a.js.gz"), "x");
      expect(jsonCli(fixture, [], 1).violations).toEqual([
        { metric: "startup JS gzip", actual: limit + 1, limit, unit: "bytes" },
      ]);
    },
  );

  it("updates the baseline from generated or explicitly measured metrics", () => {
    const { run, baselinePath, distDir } = createCliFixture();
    const update = (args: string[] = []) => {
      const result = run(["--update-baseline", ...args]);
      expect(result.status, result.stderr).toBe(0);
      return readBaseline(baselinePath);
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
    expect(readBaseline(baselinePath)).toMatchObject({
      startupJsGzipBytes: 321,
      reason: "explicit measurement",
    });
  });

  it.each([
    { name: "lowering", baseline: JSON.stringify(startupBaseline(5_000)), exitCode: 0 },
    { name: "malformed", baseline: '{"startupJsGzipBytes":"not-a-number"}\n', exitCode: 1 },
    { name: "missing", baseline: null, exitCode: 1 },
  ])("executes the $name baseline hint with the canonical preload", ({ baseline, exitCode }) => {
    const { rootDir, run, baselinePath } = createCliFixture();
    if (baseline === null) {
      fs.unlinkSync(baselinePath);
    } else {
      fs.writeFileSync(baselinePath, baseline);
    }
    const report = run();
    expect(report.status, report.stderr).toBe(exitCode);
    const output = exitCode === 0 ? report.stdout : report.stderr;
    if (exitCode !== 0) {
      expectReportText(
        output,
        "Cannot read Control UI startup budget baseline",
        `Regenerate it with ${baselineUpdateCommand}.`,
      );
    }
    const command = output.match(/node --import [^\r\n]*?--reason "<reason>"/u)?.[0];
    // Never spawn an old raw-tsx hint: it could access the host's shared cache.
    expect(command).toBe(baselineUpdateCommand);

    const reason = "fixture hint update";
    const args = command!
      .slice("node ".length)
      .split(" ")
      .map((arg) => (arg === '"<reason>"' ? reason : arg));
    const beforeDate = new Date().toISOString().slice(0, 10);
    const update = runNode(args, rootDir);
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

describe("archived Control UI performance", () => {
  const commandTest = createCommandTest();
  const repoRoot = process.cwd();
  const cliNames = [
    "check-control-ui-performance-base",
    "check-control-ui-performance",
    "check-control-ui-precompressed-assets",
  ];
  const candidateMain =
    'import "./style.css"; import { message } from "../packages/styles/main.js"; document.body.textContent = message;';
  const baseConfig = `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { gzip } from "pako";
const outDir = path.resolve(import.meta.dirname, "../dist/control-ui");
export function createControlUiPrecompressedAssetVariants(fileName, source) {
  return [
    { fileName: fileName + ".gz", source: gzip(source, { level: 0, legacyHash: true }) },
    { fileName: fileName + ".br", source: brotliCompressSync(source) },
  ];
}
export default {
  build: { outDir, emptyOutDir: true },
  plugins: [{ name: "fixture-precompression", writeBundle(_options, bundle) {
    fs.writeFileSync(path.join(outDir, ".build-inputs.json"), JSON.stringify(
      [...this.getModuleIds()].filter((file) => path.isAbsolute(file) && !file.includes("node_modules/")).map((file) => path.relative(path.resolve(import.meta.dirname, ".."), file))
    ));
    fs.appendFileSync(process.env.OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE, JSON.stringify({
      identity: ["GIT_COMMIT", "OPENCLAW_BUILD_TIMESTAMP", "GIT_BRANCH", "OPENCLAW_CONTROL_UI_BUILD_ID", "OPENCLAW_CONTROL_UI_RELEASE_BUILD"].map((key) => process.env[key]),
      gitDisabled: !fs.existsSync(process.env.GIT_DIR ?? "") && spawnSync("git", ["rev-parse", "HEAD"]).status !== 0,
      packageVersion: JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")).version,
      entryCode: Object.values(bundle).find((output) => output.type === "chunk" && output.isEntry).code,
    }) + "\\n");
    for (const output of Object.values(bundle)) {
      if (!/\\.(css|js)$/.test(output.fileName)) continue;
      for (const variant of createControlUiPrecompressedAssetVariants(output.fileName, fs.readFileSync(path.join(outDir, output.fileName)))) {
        fs.writeFileSync(path.join(outDir, variant.fileName), variant.source);
      }
    }
  } }],
};
`;
  const candidateConfig = baseConfig
    .replace("level: 0", "level: 9")
    .replace("export function createControlUi", "export async function createControlUi")
    .replace(
      'name: "fixture-precompression", writeBundle',
      'name: "fixture-precompression", async writeBundle',
    )
    .replace(
      "for (const variant of createControlUi",
      "for (const variant of await createControlUi",
    );
  const css = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const hash = createHash("sha256").update(String(index)).digest("hex");
      return `.rule-${hash.slice(0, 12)}{color:#${hash.slice(12, 18)};padding:${index % 97}px}`;
    }).join("\n");

  async function createComparisonRepo(
    command: CommandFixture,
    { baseOnlyDependency = false, brokenSource = false } = {},
  ) {
    const diagnostics = command.enableDiagnostics("control-ui-performance-base");
    diagnostics.stage("fixture");
    const temporaryRoot = fs.realpathSync(command.createTempDir("ui-budget-proof-"));
    const root = path.join(temporaryRoot, "repo");
    const at = (...parts: string[]) => path.join(root, ...parts);
    const scratch = path.join(temporaryRoot, "scratch");
    const identityCapture = path.join(temporaryRoot, "build-identities.jsonl");
    const env = createNestedGitEnv();
    const run = (bin: string, args: string[], runEnv = env) =>
      command.run(bin, args, { cwd: root, env: runEnv });
    const gitIdentity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
    const write = (file: string, text: string) => {
      const target = at(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };
    const git = async (...args: string[]) => {
      const result = await run("git", [...gitIdentity, ...args]);
      expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
      return result.stdout.trim();
    };
    const commit = async (message: string) => {
      diagnostics.stage(`commit ${message}`);
      await git("add", ".");
      await git("commit", "--quiet", "-m", message);
      return git("rev-parse", "HEAD");
    };
    fs.mkdirSync(scratch, { recursive: true });
    fs.mkdirSync(at("extensions"), { recursive: true });
    installDistArtifactScripts(root, [], { compiler: false });
    for (const [file, source] of performanceSources) {
      write(file, source);
    }
    for (const script of [
      ...cliNames
        .filter((name) => name !== "check-control-ui-performance")
        .map((name) => `${name}.mts`),
      "lib/repo-root.mjs",
      "lib/output-root-guard.mjs",
    ]) {
      fs.copyFileSync(path.join(repoRoot, "scripts", script), at("scripts", script));
    }
    const manifest = (file: string, value: object) => write(file, JSON.stringify(value));
    manifest("package.json", {
      name: "ui-budget-proof",
      version: "1.0.0",
      type: "module",
      ...(baseOnlyDependency
        ? { dependencies: { "base-only-library": "file:vendor/base-only-library" } }
        : {}),
    });
    for (const [file, source] of Object.entries({
      "scripts/tsx.mjs": `await import(${JSON.stringify(tsxImport)});\n`,
      ".gitignore": "node_modules\ndist/\n",
      "vendor/base-only-library/package.json":
        '{"name":"base-only-library","version":"1.0.0","type":"module","exports":"./index.js"}',
      "vendor/base-only-library/index.js": 'export const value = "base dependency";',
      "extensions/fixture/package.json": '{"name":"fixture"}',
      "pnpm-workspace.yaml": 'packages: ["ui", "packages/styles", "packages/workspace-value"]\n',
      "ui/package.json": '{"name":"ui-budget-proof-ui","type":"module"}',
      "ui/index.html": '<script type="module" src="/main.js"></script>',
      "ui/main.js": brokenSource
        ? "export const = broken;"
        : baseOnlyDependency
          ? 'import "./style.css"; import { message } from "../packages/styles/main.js"; import { value } from "base-only-library"; document.body.textContent = message + "/" + value;'
          : candidateMain,
      "packages/styles/main.js":
        'import "sizing-library/style.css"; export { message } from "fixture-workspace-value";',
      "packages/workspace-value/package.json":
        '{"name":"fixture-workspace-value","type":"module","exports":"./index.js"}',
      "packages/workspace-value/index.js": 'export const message = "base workspace";',
      "packages/styles/node_modules/sizing-library/package.json":
        '{"name":"sizing-library","exports":{"./style.css":"./style.css"}}',
      "packages/styles/node_modules/sizing-library/style.css": ".package-style{display:flex}",
      "ui/vite.config.ts": baseConfig,
      "ui/style.css": css(1_000),
      "scripts/build-plugin-control-ui.mts": `
import fs from "node:fs";
import path from "node:path";
const output = path.join(process.argv[3], "dist/extensions/fixture");
fs.mkdirSync(path.join(output, "dist/control-ui"), { recursive: true });
fs.writeFileSync(path.join(output, "package.json"), '{"name":"fixture"}');
fs.writeFileSync(path.join(output, "openclaw.plugin.json"), '{"id":"fixture","controlUi":{"entry":"dist/control-ui/index.js"}}');
fs.writeFileSync(path.join(output, "dist/control-ui/index.js"), "native presenter");
`,
    })) {
      write(file, source);
    }
    fs.symlinkSync(
      at("packages/workspace-value"),
      at("packages/styles/node_modules/fixture-workspace-value"),
      "junction",
    );
    manifest("config/control-ui-startup-budget-baseline.json", {
      startupJsGzipBytes: 10_000,
      reason: "synthetic fixture",
      updatedAt: "2026-09-02",
    });
    if (baseOnlyDependency) {
      diagnostics.stage("lockfile");
      const lockfile = await run("pnpm", [
        "install",
        "--lockfile-only",
        "--no-frozen-lockfile",
        "--ignore-scripts",
        "--offline",
      ]);
      expect(lockfile, `${lockfile.stdout}${lockfile.stderr}`).toMatchObject({
        error: undefined,
        status: 0,
      });
    }
    diagnostics.stage("init");
    await git("init", "--quiet");
    const base = await commit(brokenSource ? "broken base" : "base");
    for (const directory of ["node_modules", "ui/node_modules"]) {
      fs.rmSync(at(directory), { recursive: true, force: true });
    }
    for (const name of ["tsx", "@openclaw/fs-safe"]) {
      fs.mkdirSync(path.dirname(at("node_modules", name)), { recursive: true });
      fs.symlinkSync(
        fs.realpathSync(path.join(repoRoot, "node_modules", name)),
        at("node_modules", name),
        "junction",
      );
    }
    const uiDependencies = at("ui/node_modules");
    fs.mkdirSync(uiDependencies);
    for (const name of ["vite", "pako"]) {
      fs.symlinkSync(
        fs.realpathSync(path.join(repoRoot, "ui/node_modules", name)),
        path.join(uiDependencies, name),
        "junction",
      );
    }
    write("package.json", '{"name":"ui-budget-proof","version":"1.0.1","type":"module"}');
    write("ui/main.js", candidateMain);
    write("ui/vite.config.ts", candidateConfig);
    write("packages/workspace-value/index.js", 'export const message = "candidate workspace";');

    diagnostics.stage("compile");
    const { bundles } = await compileFixture(
      root,
      [...cliNames.map((name) => `scripts/${name}.mts`), "ui/vite.config.ts"],
      { deps: { neverBundle: ["pako", "@openclaw/fs-safe"] } },
    );
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
    // Keep the real CLI's source-relative subprocess paths and direct-run guards.
    for (const name of cliNames) {
      fs.copyFileSync(at("scripts", `${name}.js`), at("scripts", `${name}.mts`));
    }

    const runComparison = async (baseRef: string, status: number) => {
      diagnostics.stage("compare");
      fs.rmSync(identityCapture, { force: true });
      const result = await run(
        process.execPath,
        ["--import", tsxImport, at("scripts/check-control-ui-performance-base.mts"), baseRef],
        {
          ...env,
          GITHUB_ACTIONS: "",
          GITHUB_STEP_SUMMARY: "",
          OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE: identityCapture,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result, output).toMatchObject({ error: undefined, status });
      expect(
        fs.readdirSync(scratch).filter((name) => name.startsWith("openclaw-ui-performance-base-")),
      ).toEqual([]);
      return { ...result, output };
    };
    const readIdentities = () =>
      fs
        .readFileSync(identityCapture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{
        gitDisabled: boolean;
        identity: unknown;
        packageVersion: string;
        entryCode: string;
      }>;
    return { temporaryRoot, root, at, base, write, commit, runComparison, readIdentities };
  }

  function test(
    name: string,
    options: Parameters<typeof createComparisonRepo>[1],
    verify: (repo: Awaited<ReturnType<typeof createComparisonRepo>>) => Promise<void>,
  ) {
    commandTest(
      name,
      ({ command }) =>
        command.lifetime.run(async () => verify(await createComparisonRepo(command, options))),
      60_000,
    );
  }

  test("compares archived source revisions", { baseOnlyDependency: true }, async (repo) => {
    repo.write("ui/style.css", css(1_400));
    const head = await repo.commit("candidate");
    expect(head).not.toBe(repo.base);
    const dependencyLinks = () =>
      ["vite", "pako"].map((name) => fs.readlinkSync(repo.at("ui/node_modules", name)));
    const links = dependencyLinks();
    const { output } = await repo.runComparison(repo.base, 1);
    expect(output).toContain(`head ${head}; base ${repo.base}; Node ${process.version}; Vite `);
    expect(output).toContain("Pako ");
    expect(output).toMatch(
      /startup JS gzip vs base: \d+ B -> \d+ B \([+-]\d+ B\); requests \d+ -> \d+/u,
    );
    expect(output).toMatch(/startup CSS gzip vs base: \d+ B -> \d+ B \(\+\d+ B/u);
    expect(output).toContain("startup CSS gzip growth:");
    const identities = repo.readIdentities();
    expect(identities).toMatchObject([
      { packageVersion: "1.0.1", gitDisabled: true },
      { packageVersion: "1.0.0", gitDisabled: true },
    ]);
    expect(identities[0]?.identity).toEqual(identities[1]?.identity);
    expect(
      identities.map(({ entryCode }) => {
        const document = {
          createElement: () => ({ relList: { supports: () => true } }),
          body: { textContent: "" },
        };
        runInNewContext(entryCode, { document });
        return document.body.textContent;
      }),
    ).toEqual(["candidate workspace", "base workspace/base dependency"]);
    // The base lockfile installs into the private archive, never the candidate checkout.
    expect(dependencyLinks()).toEqual(links);
    for (const directory of ["node_modules", "ui/node_modules"]) {
      expect(fs.existsSync(repo.at(directory, "base-only-library"))).toBe(false);
    }
    expect(fs.existsSync(repo.at("dist/control-ui/index.html"))).toBe(true);
  });

  test("distinguishes failure from signal", { brokenSource: true }, async (repo) => {
    const signalMarker = path.join(repo.temporaryRoot, "signaled-base-config");
    repo.write(
      "ui/vite.config.ts",
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(signalMarker)}, "loaded");
export default { plugins: [{ name: "signal", buildStart() { process.kill(process.pid, "SIGTERM"); } }] };
`,
    );
    const signaledBase = await repo.commit("signaled base");
    repo.write("ui/vite.config.ts", candidateConfig);
    const { output: brokenBaseOutput } = await repo.runComparison(repo.base, 0);
    expect(brokenBaseOutput).toContain(
      "Base Control UI source does not build with the candidate toolchain; enforcing candidate absolute budgets without a differential comparison.",
    );
    expect(brokenBaseOutput).not.toContain("startup CSS gzip vs base:");
    expect(repo.readIdentities()).toHaveLength(1);
    const { output: signaledBaseOutput } = await repo.runComparison(signaledBase, 1);
    expect(fs.readFileSync(signalMarker, "utf8")).toBe("loaded");
    expect(signaledBaseOutput).toContain(`${path.basename(process.execPath)} failed (SIGTERM)`);
    expect(signaledBaseOutput).not.toContain(
      "Base Control UI source does not build with the candidate toolchain",
    );
  });

  test(
    "reuses identical inputs but rebuilds source-specific Settings changes",
    {},
    async (repo) => {
      repo.write("ui/src/unused.test.ts", "export const fixture = 1;\n");
      const base = await repo.commit("matching production inputs");
      repo.write("ui/src/unused.test.ts", "export const fixture = 2;\n");
      await prepareControlUiSettings(repo.root, path.join(repo.root, "scripts"));
      const unchanged = await repo.runComparison(base, 0);
      expect(unchanged.output).toContain("identical build inputs; reusing candidate as base");
      expect(unchanged.output).toMatch(/startup JS gzip vs base: \d+ B -> \d+ B \(\+0 B\)/u);
      expect(repo.readIdentities()).toHaveLength(1);

      const builder = fs.readFileSync(repo.at("scripts/build-plugin-control-ui.mts"), "utf8");
      repo.write(
        "scripts/build-plugin-control-ui.mts",
        builder.replace("native presenter", "updated native presenter"),
      );
      await prepareControlUiSettings(repo.root, path.join(repo.root, "scripts"));
      const changed = await repo.runComparison(base, 0);
      expect(changed.output).not.toContain("identical build inputs; reusing candidate as base");
      expect(repo.readIdentities()).toHaveLength(2);
      expect(
        fs.readFileSync(repo.at("dist/extensions/fixture/dist/control-ui/index.js"), "utf8"),
      ).toBe("updated native presenter");
    },
  );

  test("refuses symlinked output roots without mutating targets", {}, async (repo) => {
    const protectedRoot = path.join(repo.temporaryRoot, "protected");
    fs.mkdirSync(protectedRoot);
    fs.writeFileSync(path.join(protectedRoot, "sentinel"), "keep");
    for (const outputRoot of ["dist", "dist/control-ui"]) {
      const target = repo.at(outputRoot);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(protectedRoot, target, "junction");
      const { stderr } = await repo.runComparison(repo.base, 1);
      expect(stderr).toContain("is a symbolic link; refusing to mutate it");
      expect(fs.readFileSync(path.join(protectedRoot, "sentinel"), "utf8")).toBe("keep");
      fs.unlinkSync(target);
    }
  });
});
