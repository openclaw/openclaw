// Protect UI E2E resource ownership across native project initialization and teardown.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.ts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

const standaloneFile = "ui/src/e2e/board-fixture.e2e.test.ts";
const bundledFile = "ui/src/e2e/mount-fallback.e2e.test.ts";
const serialBundledFile = "ui/src/e2e/chat-stream-runtime-budgets.e2e.test.ts";
const qaLabFiles = [
  "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
] as const;
const realGatewayFiles = [
  "activity-run-inspector.real-gateway",
  "agent-file-lifecycle.real-gateway",
  "background-work.real-gateway",
  "chat-agent-avatar.real-gateway",
  "chat-collaborator-scroll.real-gateway",
  "chat-composer-websearch-kill-switch.real-gateway",
  "chat-flow.catalog-bootstrap",
  "chat-loading-performance.real-gateway",
  "chat-project-media.real-gateway",
  "chat-session-diff-folding.real-gateway",
  "chat-stop-finished-run.real-gateway",
  "chat-stop-owned-exec.real-gateway",
  "chat-thinking-metadata.real-gateway",
  "chat-tts-supplement.real-gateway",
  "chat-wait-clock.real-gateway",
  "chat-widget-sandbox.real-gateway",
  "command-palette-catalog.real-gateway",
  "command-palette-search.real-gateway",
  "control-ui-auth-transports",
  "cron-duration-save.real-gateway",
  "desktop-resize.real-gateway",
  "device-alias-rename.real-gateway",
  "device-platform-family.real-gateway",
  "logs-lifecycle",
  "mcp-app-conformance",
  "model-api-keys.real-gateway",
  "model-catalog-partial-refresh.real-gateway",
  "model-picker-search.real-gateway",
  "profile-page.real-gateway",
  "provider-browser-login.real-gateway",
  "quota-reset-status.real-gateway",
  "session-pr-reader-lifetime.real-gateway",
  "session-progress-hovercard.real-gateway",
  "session-roster-request-rate.real-gateway",
  "usage-sessions-owner-attribution",
  "worker-initial-setup.real-gateway",
]
  .map((name) => `ui/src/e2e/${name}.e2e.test.ts`)
  .concat(qaLabFiles);
const mcpFile = "ui/src/e2e/mcp-app-conformance.e2e.test.ts";
const builtGatewayFile = "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts";
const prebuiltBuildInfo = { buildId: "prepared-ui-build", version: "2026.9.23" };

type OwnershipProbe = {
  files: Array<{
    file: string;
    project: string;
    phase: number;
    workers: number;
    fileParallelism: boolean;
  }>;
  contexts: Array<{
    name: string;
    chromium?: { available: boolean };
    url?: string | null;
    buildInfo?: typeof prebuiltBuildInfo | null;
    bridge: boolean;
  }>;
  leases: Array<{ outDir: string; closed: boolean; removed: boolean }>;
  shards: string[][];
  steps: Array<{ builds: number; previews: number; closes: number }>;
  lifecycle: string[];
  admissions: string[];
  canonicalAssetsIntact: boolean;
  rootWorkers: number;
  setupError?: string;
};

function probeOwnership(
  options: {
    prebuilt?: boolean;
    filters?: string[];
    cli?: string[];
    project?: string[];
    include?: string[];
    skipRealGateway?: boolean;
    available?: boolean;
    initialize?: string[][];
    failure?: "build" | "preview" | "provide" | "admission" | "preflight";
  } = {},
): OwnershipProbe {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-ui-ownership-")));
  tempDirs.push(directory);
  const eventsFile = path.join(directory, "leases.jsonl");
  const lifecycleFile = path.join(directory, "lifecycle.jsonl");
  const admissionsFile = path.join(directory, "admissions.jsonl");
  const canonicalRoot = path.join(directory, "canonical-ui");
  fs.mkdirSync(canonicalRoot);
  fs.writeFileSync(path.join(canonicalRoot, "bundle.html"), "canonical fixture");
  const resourceFile = path.join(directory, "resources.mjs");
  fs.writeFileSync(
    resourceFile,
    `
    import fs from "node:fs";
    export const resolvePlaywrightChromiumExecutablePath = () => "/fixture/chromium";
    export const canRunPlaywrightChromium = () => ${options.available !== false};
    export const assertUiE2ePreflight = async () => {
      if (${JSON.stringify(options.failure)} === "preflight") throw new Error("fixture preflight failed");
    };
    const lifecycle = event => fs.appendFileSync(${JSON.stringify(lifecycleFile)}, JSON.stringify(event) + "\\n");
    export async function prepareNativeControlUiPluginFixtures() {
      lifecycle("native-fixtures");
      return { catalog: { revision: "fixture", plugins: [], diagnostics: [] }, assets: new Map() };
    }
    export default function admission(project) {
      fs.appendFileSync(${JSON.stringify(admissionsFile)}, JSON.stringify(project.name) + "\\n");
      if (${JSON.stringify(options.failure)} === "admission") throw new Error("fixture admission failed");
      project.vitest.getRootProject().provide("controlUiE2ePrebuiltAssets", {
        root: ${JSON.stringify(canonicalRoot)}, buildInfo: ${JSON.stringify(prebuiltBuildInfo)},
      });
    }
    function lease(outDir, built) {
      lifecycle(built ? "bundle-server" : "prebuilt-server");
      const record = (closed) => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ outDir, closed, built }) + "\\n");
      record(false);
      const failure = built ? "build" : "preview";
      if (${JSON.stringify(options.failure)} === failure) throw new Error("fixture " + failure + " failed");
      return { baseUrl: "http://127.0.0.1:12345/", close: async () => record(true) };
    }
    export async function startBundledControlUiE2eServer(outDir) {
      fs.writeFileSync(outDir + "/bundle.html", "fixture");
      return lease(outDir, true);
    }
    export async function startBuiltControlUiE2eServer(outDir) {
      if (!fs.existsSync(${JSON.stringify(admissionsFile)})) throw new Error("preview preceded admission");
      if (outDir !== ${JSON.stringify(canonicalRoot)} || fs.readFileSync(outDir + "/bundle.html", "utf8") !== "canonical fixture") {
        throw new Error("preview did not borrow admitted artifacts");
      }
      return lease(outDir, false);
    }
  `,
  );
  const configFile = path.join(directory, "config.mjs");
  fs.writeFileSync(
    configFile,
    `
    import config from ${JSON.stringify(path.join(repoRoot, `test/vitest/vitest.ui-e2e${options.prebuilt ? "-prebuilt" : ""}.config.ts`))};
    function instrument(config) {
      return { ...config, resolve: { ...config.resolve, alias: [
        { find: /^.*\\/control-ui-plugin-fixture[.]ts$/, replacement: ${JSON.stringify(resourceFile)} },
        { find: /^.*\\/control-ui-e2e\\.ts$/, replacement: ${JSON.stringify(resourceFile)} },
        { find: /^.*\\/vitest\\.ui-e2e-prebuilt\\.global-setup\\.ts$/, replacement: ${JSON.stringify(resourceFile)} },
        { find: /^.*vitest[.]ui-e2e-preflight[.]ts$/, replacement: ${JSON.stringify(resourceFile)} },
        ...(config.resolve?.alias ?? []),
      ] }, test: { ...config.test,
        ...(config.test?.projects ? { projects: config.test.projects.map(instrument) } : {}),
      } };
    }
    export default instrument(config);
  `,
  );
  const includeFile = path.join(directory, "include.json");
  fs.writeFileSync(includeFile, JSON.stringify(options.include ?? []));
  // Native discovery/setup owns selection; stub only the expensive resource and admission calls.
  // The admission owner's separate tests exercise real freshness checks and teardown fingerprints.
  // No browser tests run; selected specifications still decide which projects acquire resources.
  const result = spawnNodeEvalSync(
    `
    import fs from "node:fs";
    import path from "node:path";
    import { createVitest, parseCLI } from "vitest/node";
    const filters = ${JSON.stringify(options.filters ?? [])};
    const args = ["run", ...filters, ...${JSON.stringify(options.cli ?? [])}];
    process.argv = [process.execPath, "vitest", ...args];
    const { options: cliOptions } = parseCLI(["vitest", ...args]);
    // Vitest's CLI makes --exclude additive before calling createVitest.
    const { exclude: cliExclude, ...parsedOptions } = cliOptions;
    const ctx = await createVitest("test", {
      ...parsedOptions, cliExclude,
      root: ${JSON.stringify(repoRoot)}, config: ${JSON.stringify(configFile)},
      configLoader: "runner", watch: false, project: ${JSON.stringify(options.project ?? [])},
    });
    const readEvents = () => fs.existsSync(${JSON.stringify(eventsFile)})      ? fs.readFileSync(${JSON.stringify(eventsFile)}, "utf8").trim().split("\\n").map(JSON.parse) : [];
    if (${JSON.stringify(options.failure)} === "provide") {
      const root = ctx.getRootProject();
      const provide = root.provide;
      root.provide = (key, value) => {
        if (key === "controlUiE2eServerBaseUrl") throw new Error("fixture provide failed");
        return provide(key, value);
      };
    }
    let report;
    try {
      const specs = [];
      const steps = [];
      let setupError;
      for (const selection of ${JSON.stringify(options.initialize ?? [options.filters ?? []])}) {
        const selected = await ctx.globTestSpecifications(selection);
        specs.push(...selected.filter(spec => !specs.some(previous =>
          previous.moduleId === spec.moduleId && previous.project === spec.project)));
        try {
          await ctx.initializeGlobalSetup(selected);
          await ctx.initializeGlobalSetup(selected);
        } catch (error) { setupError = error.message; }
        const events = readEvents();
        steps.push({ builds: events.filter(event => !event.closed && event.built).length,
          previews: events.filter(event => !event.closed).length,
          closes: events.filter(event => event.closed).length });
      }
      const projects = [...new Set(specs.map(spec => spec.project))];
      const relative = file => path.relative(${JSON.stringify(repoRoot)}, file).replaceAll("\\\\", "/");
      const sequencer = new ctx.config.sequence.sequencer(ctx);
      const shards = [];
      for (let index = 1; index <= 11; index++) {
        ctx.config.shard = { index, count: 11 };
        shards.push((await sequencer.shard(specs)).map(spec => relative(spec.moduleId)));
      }
      report = {
        // Filesystem discovery order is not a contract; retain every file/project pair.
        files: specs.map(spec => ({ file: relative(spec.moduleId), project: spec.project.name,
          phase: spec.project.config.sequence.groupOrder,
          workers: spec.project.config.maxWorkers ?? ctx.config.maxWorkers,
          fileParallelism: spec.project.config.fileParallelism,
        }))
          .toSorted((a, b) => a.file.localeCompare(b.file)),
        contexts: projects.map(project => ({ name: project.name,
          chromium: project.getProvidedContext().controlUiE2eChromium,
          url: project.getProvidedContext().controlUiE2eServerBaseUrl,
          buildInfo: project.getProvidedContext().controlUiE2eServerBuildInfo,
          bridge: project.config.setupFiles.some(file => file.endsWith("/vitest.ui-e2e.setup.ts")),
        })), shards, steps, setupError, rootWorkers: ctx.config.maxWorkers,
        lifecycle: fs.existsSync(${JSON.stringify(lifecycleFile)})
          ? fs.readFileSync(${JSON.stringify(lifecycleFile)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [],
        admissions: fs.existsSync(${JSON.stringify(admissionsFile)})
          ? fs.readFileSync(${JSON.stringify(admissionsFile)}, "utf8").trim().split("\\n").map(JSON.parse) : [],
      };
    } finally { await ctx.close(); }
    const events = readEvents();
    report.leases = events.filter(event => !event.closed).map(event => ({
      outDir: event.outDir, closed: events.filter(other => other.outDir === event.outDir && other.closed).length === 1,
      removed: !fs.existsSync(event.outDir),
    }));
    report.canonicalAssetsIntact = fs.existsSync(${JSON.stringify(canonicalRoot)}) &&
      fs.readFileSync(${JSON.stringify(path.join(canonicalRoot, "bundle.html"))}, "utf8") === "canonical fixture";
    console.log("OWNERSHIP " + JSON.stringify(report));
  `,
    {
      cwd: repoRoot,
      timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        // Discovery runs no tests; keep scheduling stable across subprocesses
        // instead of comparing different snapshots of the host's current load.
        CI: "1",
        OPENCLAW_VITEST_INCLUDE_FILE: options.include ? includeFile : "",
        OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: options.skipRealGateway ? "1" : "",
      },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const report = result.stdout.split("\n").find((line) => line.startsWith("OWNERSHIP "));
  expect(report, result.stdout).toBeDefined();
  return JSON.parse(report!.slice("OWNERSHIP ".length)) as OwnershipProbe;
}

describe("Control UI E2E resource ownership", () => {
  it("refuses a selected project before acquiring fixtures when environment preflight fails", () => {
    const result = probeOwnership({ filters: [bundledFile], failure: "preflight" });
    expect(result.setupError).toBe("fixture preflight failed");
    expect(result.leases).toEqual([]);
    expect(result.steps).toEqual([{ builds: 0, previews: 0, closes: 0 }]);
  });

  it.each([
    { first: bundledFile, second: serialBundledFile, available: true },
    { first: serialBundledFile, second: bundledFile, available: true },
    { first: bundledFile, second: serialBundledFile, available: false },
  ])(
    "shares the bundle fact after standalone selection, $first then $second (Chromium: $available)",
    ({ first, second, available }) => {
      const result = probeOwnership({
        initialize: [[standaloneFile], [first], [second]],
        available,
      });
      expect(result.setupError).toBeUndefined();
      expect(result.steps).toEqual([
        { builds: 0, previews: 0, closes: 0 },
        { builds: available ? 1 : 0, previews: available ? 1 : 0, closes: 0 },
        { builds: available ? 1 : 0, previews: available ? 1 : 0, closes: 0 },
      ]);
      expect(result.leases).toEqual(
        available ? [{ outDir: expect.any(String), closed: true, removed: true }] : [],
      );
      expect(
        result.contexts.filter((context) => context.bridge).map((context) => context.url),
      ).toEqual([
        available ? "http://127.0.0.1:12345/" : null,
        available ? "http://127.0.0.1:12345/" : null,
      ]);
    },
  );

  it.each([
    { failure: "build", prebuilt: false },
    { failure: "provide", prebuilt: false },
    { failure: "preview", prebuilt: true },
    { failure: "provide", prebuilt: true },
  ] as const)(
    "cleans owned resources after native $failure failure (prebuilt: $prebuilt)",
    ({ failure, prebuilt }) => {
      const result = probeOwnership({
        filters: [prebuilt ? qaLabFiles[0] : bundledFile],
        failure,
        prebuilt,
      });
      expect(result.setupError).toBe(`fixture ${failure} failed`);
      expect(result.leases).toEqual([
        { outDir: expect.any(String), closed: failure === "provide", removed: !prebuilt },
      ]);
      expect(result.canonicalAssetsIntact).toBe(true);
    },
  );

  it("owns the complete inventory once and shards the project union without losing QA Lab or real-Gateway siblings", async () => {
    const { createUiE2eVitestConfig, uiE2ePrivateServerTestFiles, uiE2eSerialTestFiles } =
      await import("./vitest/vitest.ui-e2e.config.ts");
    const config = createUiE2eVitestConfig();
    const projects = config.test?.projects as
      | Array<{ extends?: boolean; test?: { clearMocks?: boolean } }>
      | undefined;
    expect(config.test?.clearMocks).toBe(false);
    expect(projects?.map((project) => project.extends)).toEqual([false, false, false, false]);
    expect(projects?.map((project) => project.test?.clearMocks)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const result = probeOwnership();
    const inventory = fs
      .globSync(["ui/src/**/*.e2e.test.ts", ...qaLabFiles], { cwd: repoRoot })
      .toSorted();
    expect(result.files.map((entry) => entry.file).toSorted()).toEqual(inventory);
    expect(result.setupError).toBeUndefined();
    expect(result.rootWorkers).toBeGreaterThan(0);
    expect(result.rootWorkers).toBeLessThanOrEqual(2);
    for (const entry of result.files) {
      const serial = uiE2eSerialTestFiles.includes(entry.file);
      expect(entry.project.startsWith("ui-e2e-serial")).toBe(serial);
      expect(entry.phase).toBe(serial ? 1 : 0);
      expect(entry.workers).toBe(serial ? 1 : result.rootWorkers);
      if (uiE2ePrivateServerTestFiles.includes(entry.file)) {
        expect(entry.project).toBe("ui-e2e-serial-standalone");
      }
    }
    expect(result.leases).toEqual([{ outDir: expect.any(String), closed: true, removed: true }]);
    expect(result.shards.flat().toSorted()).toEqual(inventory);
    expect(new Set(result.shards.flat()).size).toBe(inventory.length);
    for (const name of new Set(result.files.map((entry) => entry.project))) {
      const selected = probeOwnership({ project: [name] });
      expect(selected.files).toEqual(result.files.filter((entry) => entry.project === name));
      expect(selected.leases).toHaveLength(name.endsWith("standalone") ? 0 : 1);
    }
    const realGateway = realGatewayFiles;
    expect(
      result.files
        .filter((entry) => realGateway.includes(entry.file))
        .map(({ file, project }) => ({ file, project })),
    ).toEqual(
      realGateway.toSorted().map((file) => ({
        file,
        project: uiE2ePrivateServerTestFiles.includes(file)
          ? "ui-e2e-serial-standalone"
          : "ui-e2e-serial",
      })),
    );
    const skipped = probeOwnership({ skipRealGateway: true });
    expect(skipped.files).toEqual(
      result.files.filter((entry) => !realGateway.includes(entry.file)),
    );
    expect(skipped.shards.flat().toSorted()).toEqual(
      inventory.filter((file) => !realGateway.includes(file)),
    );
    expect(result.admissions).toEqual([]);
    expect(skipped.admissions).toEqual([]);
  });

  it.each([undefined, 1])(
    "admits every prebuilt real-Gateway file once with the native worker cap %s",
    async (workers) => {
      const { uiE2ePrivateServerTestFiles } = await import("./vitest/vitest.ui-e2e.config.ts");
      const result = probeOwnership({
        prebuilt: true,
        cli: workers === undefined ? [] : ["--maxWorkers", String(workers)],
      });
      expect(result.setupError).toBeUndefined();
      expect(result.files.map((entry) => entry.file).toSorted()).toEqual(
        realGatewayFiles.toSorted(),
      );
      expect(result.shards.flat().toSorted()).toEqual(realGatewayFiles.toSorted());
      expect(new Set(result.shards.flat()).size).toBe(realGatewayFiles.length);
      expect(result.rootWorkers).toBeGreaterThan(0);
      expect(result.rootWorkers).toBeLessThanOrEqual(2);
      if (workers !== undefined) {
        expect(result.rootWorkers).toBe(workers);
      }
      expect(result.files.filter((entry) => entry.phase === 1)).toEqual([
        {
          file: "ui/src/e2e/background-work.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/chat-collaborator-scroll.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/chat-session-diff-folding.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/chat-stop-owned-exec.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/chat-tts-supplement.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/chat-wait-clock.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/command-palette-search.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/device-platform-family.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: mcpFile,
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/provider-browser-login.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/session-pr-reader-lifetime.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
        {
          file: "ui/src/e2e/session-roster-request-rate.real-gateway.e2e.test.ts",
          project: "ui-e2e-serial-standalone",
          phase: 1,
          workers: 1,
          fileParallelism: false,
        },
      ]);
      const parallel = result.files.filter((entry) => entry.phase === 2);
      expect(parallel).toHaveLength(27);
      expect(parallel.every((entry) => entry.fileParallelism)).toBe(true);
      expect(parallel.every((entry) => entry.workers === result.rootWorkers)).toBe(true);
      for (const entry of parallel) {
        expect(entry.project).toBe(
          uiE2ePrivateServerTestFiles.includes(entry.file)
            ? "ui-e2e-real-gateway-standalone"
            : "ui-e2e-real-gateway",
        );
      }
      expect(result.admissions.toSorted()).toEqual(
        result.contexts.map((entry) => entry.name).toSorted(),
      );
      expect(result.leases).toEqual([{ outDir: expect.any(String), closed: true, removed: false }]);
      expect(result.steps).toEqual([{ builds: 0, previews: 1, closes: 0 }]);
      expect(result.canonicalAssetsIntact).toBe(true);
      expect(
        result.contexts.every(
          (context) => context.buildInfo?.buildId === prebuiltBuildInfo.buildId,
        ),
      ).toBe(true);
    },
  );

  it("keeps prebuilt preview acquisition lazy across native project initialization", () => {
    const result = probeOwnership({
      prebuilt: true,
      initialize: [[builtGatewayFile], [mcpFile], [qaLabFiles[0]], [qaLabFiles[1]]],
    });
    expect(result.setupError).toBeUndefined();
    expect(result.steps).toEqual([
      { builds: 0, previews: 0, closes: 0 },
      { builds: 0, previews: 0, closes: 0 },
      { builds: 0, previews: 1, closes: 0 },
      { builds: 0, previews: 1, closes: 0 },
    ]);
    expect(result.admissions).toHaveLength(3);
    expect(new Set(result.admissions).size).toBe(3);
    expect(result.leases).toEqual([{ outDir: expect.any(String), closed: true, removed: false }]);
    expect(result.canonicalAssetsIntact).toBe(true);
  });

  it("propagates prebuilt admission failure before acquiring the preview", () => {
    const result = probeOwnership({
      prebuilt: true,
      filters: [qaLabFiles[0]],
      failure: "admission",
    });
    expect(result.setupError).toBe("fixture admission failed");
    expect(result.admissions).toEqual(["ui-e2e-real-gateway"]);
    expect(result.steps).toEqual([{ builds: 0, previews: 0, closes: 0 }]);
    expect(result.leases).toEqual([]);
    expect(result.canonicalAssetsIntact).toBe(true);
    expect(result.contexts.every((context) => context.url === undefined)).toBe(true);
  });
});
