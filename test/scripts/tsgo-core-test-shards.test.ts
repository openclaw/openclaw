import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listStagedChangedPaths } from "../../scripts/changed-lanes.mts";
import { readNativeTypeScriptConfig } from "../../scripts/lib/native-typescript-config.mts";
import {
  expandTsgoExecutionGraphs,
  resolveCiTsgoGraphs,
  TSGO_ROOT_TEST_SHARDS,
  findOversizedTsgoCoreTestShards,
  findTsgoCoreTestShardViolations,
  selectChangedTsgoCoreTestShards,
  TSGO_CORE_GRAPHS,
  TSGO_CI_ADDITIONAL_GRAPHS,
  selectTsgoCoreTestShards,
  selectTsgoCoreTestStripe,
  TSGO_CORE_TEST_SHARDS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import {
  materializeNativeCompiler,
  overrideNativeFixtureExecutable,
} from "./native-boundary-fixture.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

describe("tsgo core test shards", () => {
  it("covers the repository test roots exactly once", () => {
    const roots = (config: string) => {
      const parsed = readNativeTypeScriptConfig({ cwd: process.cwd(), configFileName: config });
      const contents = JSON5.parse(fs.readFileSync(config, "utf8")) as { references?: unknown };
      // Project references are not inherited and the native config response omits them.
      expect(contents.references ?? [], config).toEqual([]);
      return parsed.fileNames
        .filter((file) => /\.test\.tsx?$/u.test(file))
        .map((file) => path.relative(process.cwd(), file).replaceAll(path.sep, "/"));
    };

    const shards = TSGO_CORE_TEST_SHARDS.map((shard) => ({
      name: shard.name,
      roots: roots(shard.config),
    }));
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: roots("test/tsconfig/tsconfig.core.test.json"),
        shards,
      }),
    ).toEqual([]);
    // Shard size is advisory: warn so a rebalance gets scheduled, never block a PR on it.
    for (const warning of findOversizedTsgoCoreTestShards({ shards })) {
      console.warn(`[tsgo-core-test-shards] warning: ${warning}`);
    }
    for (const [file, owner] of [
      ["src/agents/sessions/settings-storage.test.ts", "agents-sessions"],
      ["src/agents/subagents/spawn/acp-spawn-target.test.ts", "agents-sessions"],
      ["src/agents/session-maintenance/run.test.ts", "agents-sessions"],
      ["src/agents/main-session-recovery/main-session-restart-recovery.test.ts", "agents-sessions"],
      ["src/agents/model-selection.test.ts", "agents-other"],
      ["src/agents/model-catalog-view.test.ts", "agents-other"],
      ["src/agents/models-config.merge.test.ts", "agents-root"],
      ["ui/src/pages/chat/chat-send-submit.test.ts", "ui-chat"],
      ["ui/src/pages/config/config-page.test.ts", "ui-pages"],
      ["ui/src/components/agent-avatar-face.test.ts", "ui-components"],
      ["src/gateway/server-methods/update-owner.test.ts", "gateway-methods"],
      ["src/gateway/talk/client-authority.test.ts", "gateway-other"],
      ["src/gateway/worker-environments/service.plugin-create.test.ts", "gateway-other"],
      ["src/gateway/server-methods/environments.test.ts", "gateway-methods"],
      ["src/commands/doctor-session-worktree-workspace.test.ts", "commands-doctor"],
      ["src/commands/doctor/repair-sequencing.test.ts", "commands-doctor"],
      ["src/commands/oauth-tls-preflight.doctor.test.ts", "commands-doctor"],
      ["src/commands/onboard-agent.test.ts", "commands"],
      ["src/agents/command/session-store.test.ts", "commands"],
      ["src/cli/program/build-program.test.ts", "commands"],
      ["src/cli/program/register.agent.test.ts", "commands"],
      ["src/tui/tui-plugin-approvals.test.ts", "commands"],
      ["src/wizard/setup.test.ts", "commands"],
      ["src/cli/cron-cli.test.ts", "services-cron"],
      ["src/cli/cron-output.process.test.ts", "services-cron"],
      ["src/cli/cron-cli/register.cron-edit.test.ts", "services-cron"],
      ["src/cron/service/run-recovery.observation.test.ts", "services-cron"],
      ["src/cli/program/command-registry.test.ts", "commands"],
      ["src/cli/update-cli.test.ts", "cli-update"],
      ["src/cli/update-cli/update-command-config-fence.test.ts", "cli-update"],
      ["src/gateway/worker-environments/admission.test.ts", "gateway-other"],
      ["src/gateway/worker-environments/computer-transport.test.ts", "gateway-other"],
      ["src/node-host/connection.test.ts", "gateway-other"],
      ["src/worker/worker-connection.test.ts", "gateway-other"],
      ["src/infra/state-migrations.test.ts", "state-logging"],
      ["src/infra/state-migrations.workspace-setup.test.ts", "state-logging"],
      ["src/gateway/server-plugin-reload.recovery.test.ts", "gateway-server"],
      ["src/gateway/server-methods/plugins.decisions.test.ts", "gateway-methods"],
      ["src/plugins/loader.native-module-loader.test.ts", "plugins-platform"],
      ["src/acp/session-new-ordering.test.ts", "plugins-platform"],
      ["src/system-agent/operations.test.ts", "services"],
      ["src/system-agent/operations.gateway-lifecycle.test.ts", "services"],
    ] as const) {
      expect(
        shards.filter((shard) => shard.roots.includes(file)).map((shard) => shard.name),
        file,
      ).toEqual([owner]);
    }
  });

  it("partitions every root-test input and preserves shared ambient context", () => {
    const canonicalOptions = readNativeTypeScriptConfig({
      cwd: process.cwd(),
      configFileName: "test/tsconfig/tsconfig.test.root.json",
    }).options;
    const semanticOptions = (options: typeof canonicalOptions) => {
      const { tsBuildInfoFile: _cache, configFilePath: _config, ...semantic } = options;
      return semantic;
    };
    const roots = (config: string) => {
      const parsed = readNativeTypeScriptConfig({ cwd: process.cwd(), configFileName: config });
      const contents = JSON5.parse(fs.readFileSync(config, "utf8")) as { references?: unknown };
      expect(contents.references ?? [], config).toEqual([]);
      expect(semanticOptions(parsed.options), config).toEqual(semanticOptions(canonicalOptions));
      return parsed.fileNames.map((file) =>
        path.relative(process.cwd(), file).replaceAll(path.sep, "/"),
      );
    };
    const canonicalConfig = "test/tsconfig/tsconfig.test.root.json";
    const canonical = roots(canonicalConfig);
    const config = JSON5.parse(fs.readFileSync(canonicalConfig, "utf8")) as { files: string[] };
    const shared = new Set([
      ...canonical.filter((file) => /\.d\.[cm]?ts$/u.test(file)),
      ...config.files.map((file) => path.posix.normalize("test/tsconfig/" + file)),
    ]);
    const caches: string[] = [];
    const shards = TSGO_ROOT_TEST_SHARDS.map((shard) => {
      const files = roots(shard.config);
      for (const file of shared) {
        expect(files, shard.name).toContain(file);
      }
      const contents = JSON5.parse(fs.readFileSync(shard.config, "utf8")) as {
        compilerOptions: { tsBuildInfoFile: string };
      };
      caches.push(
        path.resolve(path.dirname(shard.config), contents.compilerOptions.tsBuildInfoFile),
      );
      return { name: shard.name, roots: files.filter((file) => !shared.has(file)) };
    });
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: canonical.filter((file) => !shared.has(file)),
        shards,
      }),
    ).toEqual([]);
    expect(new Set(caches).size).toBe(shards.length);
    expect(
      caches.every((file) => file.startsWith(path.resolve(".artifacts/tsgo-cache") + path.sep)),
    ).toBe(true);
  });

  it("expands canonical root CI selection without changing core stripe ownership", () => {
    const graphs = resolveCiTsgoGraphs(["scripts", "test-root"]);
    expect(graphs.map((graph) => graph.name)).toEqual(["scripts", "test-root"]);
    expect(expandTsgoExecutionGraphs(graphs)).toEqual([graphs[0], ...TSGO_ROOT_TEST_SHARDS]);
    expect(selectTsgoCoreTestShards("root")).toEqual(TSGO_ROOT_TEST_SHARDS);
    expect(expandTsgoExecutionGraphs(TSGO_CORE_TEST_SHARDS)).toEqual(TSGO_CORE_TEST_SHARDS);
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["tsgo:test:root"]).toBe(
      "node scripts/run-tsgo-core-test-shards.mjs root",
    );
  });

  it("stripes partition the full shard list exactly once", () => {
    for (const stripeCount of [1, 2, 3, 5]) {
      const striped = Array.from(
        { length: stripeCount },
        (_, index) => selectTsgoCoreTestStripe(`${index + 1}/${stripeCount}`) ?? [],
      );
      expect(
        striped
          .flat()
          .map((shard) => shard.name)
          .toSorted(),
      ).toEqual(TSGO_CORE_TEST_SHARDS.map((shard) => shard.name).toSorted());
      // Round-robin keeps stripe sizes within one shard of each other.
      const sizes = striped.map((shards) => shards.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
    expect(selectTsgoCoreTestStripe("0/2")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("3/2")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("src")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("2-1/5")).toBeUndefined();
    expect(selectTsgoCoreTestStripe("1-6/5")).toBeUndefined();
    const paired = ["1-2/5", "3-4/5", "5/5"].flatMap(
      (stripe) => selectTsgoCoreTestStripe(stripe) ?? [],
    );
    expect(paired.map((shard) => shard.name).toSorted()).toEqual(
      TSGO_CORE_TEST_SHARDS.map((shard) => shard.name).toSorted(),
    );
    expect(selectTsgoCoreTestStripe("1-2/5")).toEqual(
      TSGO_CORE_TEST_SHARDS.filter((shard) =>
        ["1/5", "2/5"].some((stripe) => selectTsgoCoreTestStripe(stripe)?.includes(shard)),
      ),
    );
  });

  it("accepts an exact once-only partition", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts"],
        shards: [
          { name: "a", roots: ["src/a.test.ts"] },
          { name: "b", roots: ["src/b.test.ts"] },
        ],
      }),
    ).toEqual([]);
  });

  it("warns about oversized shards without treating them as violations", () => {
    const shards = [
      { name: "big", roots: ["src/a.test.ts", "src/b.test.ts"] },
      { name: "small", roots: ["src/c.test.ts"] },
    ];
    expect(findOversizedTsgoCoreTestShards({ maxRoots: 1, shards })).toEqual([
      "big: 2 test roots exceeds the advisory 1 limit; rebalance when convenient",
    ]);
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"],
        shards,
      }),
    ).toEqual([]);
  });

  it("reports missing, duplicate, and extra shard roots", () => {
    expect(
      findTsgoCoreTestShardViolations({
        canonicalRoots: ["src/a.test.ts", "src/b.test.ts", "src/missing.test.ts"],
        shards: [
          { name: "first", roots: ["src/a.test.ts", "src/b.test.ts"] },
          { name: "second", roots: ["src/b.test.ts", "src/extra.test.ts"] },
        ],
      }),
    ).toEqual([
      "assigned 2 times (first, second): src/b.test.ts",
      "unassigned: src/missing.test.ts",
      "not in the canonical core-test graph (second): src/extra.test.ts",
    ]);
  });

  it.each(["src", "ui", "packages"])(
    "retains shared extension declarations for the %s alias",
    (group) => {
      const shards = selectTsgoCoreTestShards(group);

      expect(shards?.at(-1)).toEqual({
        name: "extension-declarations",
        config: "test/tsconfig/tsconfig.test.extension-declarations.json",
        sparseRoots: ["extensions", "src", "ui/src"],
      });
    },
  );

  it("keeps the full core-test run scoped to its canonical shards", () => {
    expect(selectTsgoCoreTestShards()).not.toContainEqual(
      expect.objectContaining({ name: "extension-declarations" }),
    );
  });

  it("keeps plugin browser source and tests in the extension type graphs", () => {
    const root = lifetime.createTempDir("openclaw-browser-type-graphs-");
    const coreConfigs = [
      "tsconfig.ui.json",
      "test/tsconfig/tsconfig.core.test.json",
      "test/tsconfig/tsconfig.core.test.ui-other.json",
    ];
    const write = (file: string, content: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    for (const config of [
      "tsconfig.json",
      "tsconfig.extensions.json",
      "test/tsconfig/tsconfig.test.json",
      "test/tsconfig/tsconfig.extensions.test.json",
      "test/tsconfig/tsconfig.core.test.shard.json",
      ...coreConfigs,
    ]) {
      write(config, fs.readFileSync(config, "utf8"));
    }
    const browserSource = "extensions/fixture/browser/index.ts";
    const browserTest = "extensions/fixture/browser/index.test.ts";
    for (const file of [
      browserSource,
      browserTest,
      "extensions/fixture/index.ts",
      "extensions/fixture/index.test.ts",
      "ui/src/main.ts",
      "ui/src/fixture.test.ts",
    ]) {
      write(file, "export {};\n");
    }
    const roots = (config: string) => {
      const parsed = readNativeTypeScriptConfig({ cwd: root, configFileName: config });
      return parsed.fileNames.map((file) => path.relative(root, file).replaceAll(path.sep, "/"));
    };

    expect(roots("tsconfig.extensions.json")).toContain(browserSource);
    expect(roots("test/tsconfig/tsconfig.extensions.test.json")).toContain(browserTest);
    for (const config of coreConfigs) {
      expect(
        roots(config).filter((file) => file.startsWith("extensions/")),
        config,
      ).toEqual([]);
    }
  });

  it("routes aggregate package aliases through bounded processes", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["tsgo:core:all"]).toContain("pnpm tsgo:core:test");
    expect(packageJson.scripts["tsgo:core:all"]).not.toContain("run-tsgo.mjs -b");
    expect(packageJson.scripts["tsgo:all"]).toContain("pnpm tsgo:core:all");
    expect(packageJson.scripts["tsgo:all"]).not.toContain("run-tsgo.mjs -b");
  });
});

describe("changed core test graph selection", () => {
  const leaf = "src/agents/nested/leaf.test.ts";
  const inventory = () =>
    TSGO_CORE_GRAPHS.map((graph) => ({
      ...graph,
      roots: graph.name === "core-test-agents-other" ? [leaf] : [],
      files: graph.name === "core-test-agents-other" ? [leaf] : [],
    }));

  it("includes a consuming graph even when another graph owns the test root", () => {
    const graphs = inventory();
    graphs.find((graph) => graph.name === "core-test-agents-tools")!.files.push(leaf);
    expect(selectChangedTsgoCoreTestShards([leaf], graphs)?.map((shard) => shard.name)).toEqual([
      "agents-other",
      "agents-tools",
    ]);
  });

  it("rejects a plugin browser test even when the inventory claims core ownership", () => {
    const pluginTest = "extensions/example/browser/page.test.ts";
    const graphs = inventory();
    const uiGraph = graphs.find((graph) => graph.name === "core-test-ui-other")!;
    uiGraph.roots = [pluginTest];
    uiGraph.files = [pluginTest];
    expect(selectChangedTsgoCoreTestShards([pluginTest], graphs)).toBeUndefined();
  });

  it.each(["src/owner.ts", "src/shared.test-support.ts", "test/helpers/shared.ts"])(
    "selects only consuming test graphs for %s alongside its production graph",
    (source) => {
      const graphs = inventory();
      for (const graph of graphs) {
        if (["core", "core-test-agents-other", "core-test-agents-tools"].includes(graph.name)) {
          graph.files.push(source);
        }
      }
      expect(selectChangedTsgoCoreTestShards([source], graphs)?.map((shard) => shard.name)).toEqual(
        ["agents-other", "agents-tools"],
      );
    },
  );

  it.for([
    [],
    ["src/owner.ts"],
    ["test/tsconfig/tsconfig.core.test.json"],
    ["src/shared.test-support.ts"],
    ["src/missing.test.ts"],
    [leaf, "package.json"],
    ["src/types/node-runtime-globals.d.ts"],
    ["tsconfig.json"],
  ])("retains full checks for unsupported changed paths %j", (paths) => {
    expect(selectChangedTsgoCoreTestShards(paths, inventory())).toBeUndefined();
  });

  it.each(["incomplete", "duplicate", "deleted", "production", "ambiguous"])(
    "retains full checks for %s ownership",
    (failure) => {
      const graphs = inventory();
      if (failure === "incomplete") {
        graphs.shift();
      }
      if (failure === "duplicate") {
        graphs.push(graphs[0]!);
      }
      if (failure === "deleted") {
        graphs.forEach((graph) => {
          graph.files = [];
        });
      }
      if (failure === "production") {
        graphs[0]!.files.push(leaf);
      }
      if (failure === "ambiguous") {
        graphs.find((graph) => graph.name === "core-test-agents-tools")!.roots.push(leaf);
      }
      expect(selectChangedTsgoCoreTestShards([leaf], graphs)).toBeUndefined();
    },
  );
});

// The compiler owns dependency reachability; test root partitions alone cannot prove it.
const lifetime = createFixtureLifetime();
let fixtureReceipts: FixtureReceiptChannel;
beforeAll(async () => {
  fixtureReceipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await fixtureReceipts.close();
});
afterEach(() => lifetime.cleanup());

it.runIf(process.platform !== "win32").each([
  ["alias", ["root"], [0, 1, 2, 3]],
  ["CI", ["--ci-graphs-json", '["test-root"]'], [0, 1, 2, 3]],
  ["mixed CI", ["--ci-graphs-json", '["scripts", "test-root"]'], [0, 1, 2, 3]],
  ["odd stripe", ["--root-stripe", "1/2"], [0, 2]],
  ["even stripe", ["--root-stripe", "2/2"], [1, 3]],
] as const)(
  "executes assigned root partitions serially through %s",
  async (_label, args, indices) => {
    await lifetime.run(async () => {
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-root-shards-"));
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      fs.mkdirSync(path.join(root, "scripts"));
      const driver = path.join(root, "scripts/run-tsgo-core-test-shards.mts");
      fs.copyFileSync(path.resolve("scripts/run-tsgo-core-test-shards.mts"), driver);
      fs.symlinkSync(path.resolve("scripts/lib"), path.join(root, "scripts/lib"), "dir");
      // Exercise the CLI and evidence owner with a compiler stub that rejects
      // overlap. Native cold graph checks separately prove the actual partitions.
      fs.writeFileSync(
        path.join(root, "scripts/run-tsgo.mts"),
        `import fs from "node:fs";
export function prepareTsgoCommand(args) { return args; }
export async function runPreparedTsgoCommand(args, options) {
  const fd = fs.openSync("active-compiler", "wx");
  try {
    const config = args[args.indexOf("-p") + 1];
    fs.appendFileSync("calls.jsonl", JSON.stringify(config) + "\\n");
    await new Promise((resolve) => setImmediate(resolve));
    const code = config === "tsconfig.scripts.json" ? 2 : config.endsWith(".scripts.json") ? Number(process.env.FIXTURE_EXIT) : 0;
    if (code === 0 || code === 2) options.onEvidence();
    return code;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync("active-compiler");
  }
}
`,
      );
      for (const exitCode of [0, 2, 137]) {
        fs.writeFileSync(path.join(root, "calls.jsonl"), "");
        const result = await lifetime.track(
          runNodeScript(
            [
              "--import",
              pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
              driver,
              ...args,
              "--concurrency",
              "4",
            ],
            {
              ...process.env,
              OPENCLAW_LOCAL_CHECK: "0",
              OPENCLAW_CI_STATIC_EVIDENCE: "1",
              FIXTURE_EXIT: String(exitCode),
            },
            undefined,
            { cwd: root, requireProcessTreeExit: true },
          ),
        );
        const selected = indices.map((index) => TSGO_ROOT_TEST_SHARDS[index]!);
        const failureIndex = selected.findIndex((graph) => graph.name === "test-root-scripts");
        const fails = exitCode !== 0 && failureIndex >= 0;
        expect(result.status, result.stderr).toBe(_label === "mixed CI" ? 2 : fails ? exitCode : 0);
        const calls = fs
          .readFileSync(path.join(root, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls).toEqual([
          ...(_label === "mixed CI" ? ["tsconfig.scripts.json"] : []),
          ...selected.slice(0, fails ? failureIndex + 1 : undefined).map((graph) => graph.config),
        ]);
        const completion = result.stdout
          .split("\n")
          .find((line) => line.startsWith("[ci-static:tsgo:completion] "));
        if (!fails && process.platform !== "win32") {
          expect(completion).toBeDefined();
          const evidence = JSON.parse(completion!.slice("[ci-static:tsgo:completion] ".length)) as {
            planned: number;
            completed: number;
            leaves: string[];
          };
          const expectedLeaves = selected.length + (_label === "mixed CI" ? 1 : 0);
          expect(evidence).toMatchObject({ planned: expectedLeaves, completed: expectedLeaves });
          expect(new Set(evidence.leaves).size).toBe(expectedLeaves);
        } else {
          expect(completion).toBeUndefined();
        }
      }
    });
  },
);

it.runIf(process.platform !== "win32")(
  "checks a helper type error in its transitive test consumers without repeating enumeration",
  ({ signal }) =>
    lifetime.run(async () => {
      const sourceRoot = process.cwd();
      const root = fs.realpathSync(lifetime.createTempDir("openclaw-changed-types-"));
      const native = materializeNativeCompiler(root);
      const write = (name: string, content: string) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return file;
      };
      write("package.json", '{"type":"module"}');
      write("pnpm-workspace.yaml", "packages: []\n");
      for (const name of [
        "check-tsgo-core-boundary.mts",
        "run-tsgo-core-test-shards.mts",
        "run-tsgo.mts",
      ]) {
        write(`scripts/${name}`, fs.readFileSync(path.join(sourceRoot, "scripts", name), "utf8"));
      }
      fs.symlinkSync(path.join(sourceRoot, "scripts/lib"), path.join(root, "scripts/lib"), "dir");
      const leaf = "src/agents/nested/leaf.test.ts";
      const consumer = "src/agents/tools/consumer.test.ts";
      const helper = "test/helpers/value.ts";
      write(helper, "export type Value = number;\n");
      write(leaf, "export type { Value } from '../../../test/helpers/value.js';\n");
      write(consumer, "export {};\n");
      write("src/empty.ts", "export {};\n");
      const configs = [
        ...TSGO_CORE_GRAPHS,
        { name: "canonical", config: "test/tsconfig/tsconfig.core.test.json" },
      ];
      for (const { name, config } of configs) {
        const files =
          name === "canonical"
            ? [leaf, consumer]
            : name === "core-test-agents-other"
              ? [leaf]
              : name === "core-test-agents-tools"
                ? [consumer]
                : ["src/empty.ts"];
        write(
          config,
          JSON.stringify({
            compilerOptions: {
              noEmit: true,
              strict: true,
              types: [],
              lib: ["es5"],
              module: "nodenext",
              target: "es2022",
              incremental: true,
              tsBuildInfoFile: path.join(root, `.artifacts/${name}.tsbuildinfo`),
            },
            files: files.map((file) => path.join(root, file)),
          }),
        );
      }
      fs.unlinkSync(path.join(root, "node_modules/.bin/tsgo"));
      // Every boundary pass queries each graph config serially. Record and exec so
      // each query stays one native process, as the production resolver launches it.
      const compiler = write(
        "node_modules/.bin/tsgo",
        `#!/bin/sh
IFS=$(printf '\\t')
printf '%s\\n' "$*" >> compiler-events.tsv
if [ "$TSGO_FIXTURE_STDERR" = 1 ]; then echo 'unclassified compiler failure' >&2; fi
exec ${JSON.stringify(native)} "$@"
`,
      );
      fs.chmodSync(compiler, 0o755);
      overrideNativeFixtureExecutable(root, compiler);
      const compilerEvents = () =>
        fs
          .readFileSync(path.join(root, "compiler-events.tsv"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t"));
      const driver = path.join(root, "scripts/run-tsgo-core-test-shards.mts");
      const preparedDriver = resolveRuntimeWorkerUrl(toolingMtsEntrypoints.tsgoCoreTestShards);
      const env = preparedScriptWrapperEnv(
        (
          [
            ["run-tsgo-core-test-shards.mts", toolingMtsEntrypoints.tsgoCoreTestShards],
            ["check-tsgo-core-boundary.mts", toolingMtsEntrypoints.tsgoCoreBoundary],
            ["run-tsgo.mts", toolingMtsEntrypoints.tsgo],
          ] as const
        ).map(([name, entry]): readonly [URL, URL] => {
          const source = pathToFileURL(path.join(root, "scripts", name));
          const prepared = resolveRuntimeWorkerUrl(entry);
          return [source, prepared.pathname.endsWith(".mts") ? source : prepared];
        }),
        { ...process.env, OPENCLAW_LOCAL_CHECK: "0" },
        [
          [
            new URL("./lib/tsdown-declaration-boundary.mts", preparedDriver),
            resolveRuntimeWorkerUrl(toolingMtsEntrypoints.tsdownDeclarationBoundary),
          ],
        ],
      );
      const changedArgs = (paths: string[]) => ["--changed-paths-json", JSON.stringify(paths)];
      const check = async (
        paths = [leaf],
        stripe?: string,
        expectedGraphListings = TSGO_CORE_GRAPHS.length,
      ) => {
        write("compiler-events.tsv", "");
        const result = await lifetime.track(
          runNodeScript(
            [
              "--import",
              pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href,
              driver,
              ...changedArgs(paths),
              ...(stripe === undefined ? [] : ["--stripe", stripe]),
            ],
            env,
            undefined,
            { cwd: root, signal, requireProcessTreeExit: true },
          ),
        );
        const calls = compilerEvents();
        expect(calls.filter((args) => args.includes("--listFilesOnly"))).toHaveLength(
          expectedGraphListings,
        );
        // Discovery and diagnostic checks both use project mode.
        const builds = calls
          .filter((args) => !args.includes("--listFilesOnly") && !args.includes("--showConfig"))
          .map((args) => args[args.indexOf("-p") + 1]);
        return { result, builds, calls };
      };
      const initial = await check([leaf], "1/5");
      expect(initial.result.status, initial.result.stderr).toBe(0);
      expect(initial.builds).toEqual([]);
      const extension = "extensions/example/value.ts";
      write(extension, "export type ExtensionValue = number;\n");
      const noncoreConsumer = "test/noncore-consumer.ts";
      write(
        noncoreConsumer,
        "export type { ExtensionValue } from '../extensions/example/value.js';\n",
      );
      for (const graph of TSGO_CI_ADDITIONAL_GRAPHS) {
        write(
          graph.config,
          JSON.stringify({
            compilerOptions: {
              noEmit: true,
              strict: true,
              types: [],
              lib: ["es5"],
              module: "nodenext",
              target: "es2022",
            },
            files: [path.join(root, noncoreConsumer)],
          }),
        );
      }
      const plannerDriver = write(
        "scripts/extension-plan-fixture.mts",
        `import { createChangedCiTypeCheckPlan } from "./run-tsgo-core-test-shards.mts";
import { checkCoreTsgoGraphBoundary } from "./check-tsgo-core-boundary.mts";
if (process.argv[2] === "boundary") {
  await checkCoreTsgoGraphBoundary();
} else {
  const plan = await createChangedCiTypeCheckPlan([process.argv[2] === "core-plan" ? ${JSON.stringify(helper)} : ${JSON.stringify(extension)}], {
    cwd: process.cwd(), coreBoundaryOwner: "additional-checks",
  });
  console.log(JSON.stringify({ mode: plan.mode, names: plan.graphs.map(({ name }) => name) }));
}
`,
      );
      const inspectExtension = async (mode: "plan" | "core-plan" | "boundary", serial = "") => {
        write("compiler-events.tsv", "");
        return await lifetime.track(
          runNodeScript(
            [
              "--import",
              pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href,
              plannerDriver,
              mode,
            ],
            { ...env, OPENCLAW_CI_TYPE_PLAN_SERIAL: serial },
            undefined,
            { cwd: root, signal, requireProcessTreeExit: true },
          ),
        );
      };
      for (const serial of ["", "1"]) {
        const extensionPlan = await inspectExtension("plan", serial);
        expect(extensionPlan.status, extensionPlan.stderr).toBe(0);
        expect(JSON.parse(extensionPlan.stdout.trim())).toEqual({
          mode: "changed",
          names: ["extensions", "extensions-test", "scripts", "test-root"],
        });
        const discovery = compilerEvents();
        expect(discovery).toHaveLength(serial ? 4 : 1);
        expect(discovery.every((args) => args.includes(serial ? "--listFilesOnly" : "--api"))).toBe(
          true,
        );
        const corePlan = await inspectExtension("core-plan", serial);
        expect(corePlan.status, corePlan.stderr).toBe(0);
        expect(JSON.parse(corePlan.stdout.trim())).toEqual({
          mode: "changed",
          names: ["core-test-agents-other"],
        });
      }
      // Its parallel owner must still reject a type-only edge into an extension.
      write(
        consumer,
        "export type { ExtensionValue } from '../../../extensions/example/value.js';\n",
      );
      const extensionBoundary = await inspectExtension("boundary");
      expect(extensionBoundary.status).not.toBe(0);
      expect(extensionBoundary.stderr).toContain(
        "Core tsgo graphs include bundled extension files",
      );
      expect(extensionBoundary.stderr).toContain(extension);
      const invalidCorePlan = await inspectExtension("core-plan");
      expect(invalidCorePlan.status).not.toBe(0);
      expect(invalidCorePlan.stderr).toContain("Core tsgo graphs include bundled extension files");
      expect(invalidCorePlan.stderr).toContain(extension);
      write(
        consumer,
        "import type {Value} from '../nested/leaf.test.js';\nconst value: Value = 1;\n",
      );
      const validConsumer = await check([helper], "2/5");
      expect(validConsumer.result.status, validConsumer.result.stderr).toBe(0);
      expect(validConsumer.builds).toEqual(["test/tsconfig/tsconfig.core.test.agents-other.json"]);
      const invalidStripe = await check([helper], "0/5", 0);
      expect(invalidStripe.result.status).not.toBe(0);
      expect(invalidStripe.result.stderr).toContain("Invalid core test stripe");
      expect(invalidStripe.calls).toEqual([]);
      // A removed rename source keeps every canonical graph assigned to this stripe.
      const missingRoot = await check([leaf, "src/agents/old.test.ts"], "2/5");
      expect(missingRoot.result.status, missingRoot.result.stderr).toBe(0);
      expect(missingRoot.builds).toEqual(
        selectTsgoCoreTestStripe("2/5")!.map((shard) => shard.config),
      );
      write(helper, "export type Value = string;\n");
      const brokenConsumer = await check([helper], "3/5");
      expect(brokenConsumer.result.status).not.toBe(0);
      expect(brokenConsumer.builds).toEqual(["test/tsconfig/tsconfig.core.test.agents-tools.json"]);
      expect([...validConsumer.builds, ...brokenConsumer.builds]).toEqual([
        "test/tsconfig/tsconfig.core.test.agents-other.json",
        "test/tsconfig/tsconfig.core.test.agents-tools.json",
      ]);
      expect(brokenConsumer.result.stdout + brokenConsumer.result.stderr).toContain(
        "consumer.test.ts(2,7): error TS2322",
      );
      write(helper, "export type Value = number;\n");
      write(
        consumer,
        "import type {Value} from '../../../test/helpers/value.js';\nconst value: Value = 1;\n",
      );
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: root, env: createNestedGitEnv(), stdio: "pipe" });
      git(["init", "-q", "--initial-branch=main"]);
      git(["config", "diff.renames", "true"]);
      git(["add", "--", helper, leaf, consumer]);
      git([
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "before helper rename",
      ]);
      git(["mv", helper, "test/helpers/renamed-value.ts"]);
      write(leaf, "export type { Value } from '../../../test/helpers/renamed-value.js';\n");
      git(["add", "--", leaf]);
      // The unchanged consumer still imports the removed helper. Destination-only
      // selection would check just the repaired leaf and miss its TS2307 diagnostic.
      const renamed = await check(listStagedChangedPaths(root));
      expect(renamed.result.status).not.toBe(0);
      expect(renamed.builds).toContain("test/tsconfig/tsconfig.core.test.agents-tools.json");
      expect(renamed.result.stdout + renamed.result.stderr).toMatch(
        /consumer\.test\.ts\(1,\d+\): error TS2307/u,
      );
      write(leaf, "export const invalid: number = 'broken';\n");
      const selectedGraphs = ["core-test-agents-other", "core-test-agents-tools"];
      for (const mode of ["default", "evidence", "unknown"] as const) {
        write("compiler-events.tsv", "");
        const result = await lifetime.track(
          runNodeScript(
            [
              "--import",
              pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href,
              driver,
              "--ci-graphs-json",
              JSON.stringify(selectedGraphs),
            ],
            {
              ...env,
              OPENCLAW_CI_STATIC_EVIDENCE: mode === "default" ? "0" : "1",
              TSGO_FIXTURE_STDERR: mode === "unknown" ? "1" : "0",
            },
            undefined,
            { cwd: root, signal, requireProcessTreeExit: true },
          ),
        );
        expect(result.status, result.stderr).toBe(2);
        expect(result.stdout).toContain("leaf.test.ts(1,14): error TS2322");
        expect(compilerEvents()).toHaveLength(mode === "evidence" ? 2 : 1);
        const receipts = result.stdout
          .split("\n")
          .filter((line) => line.startsWith("[ci-static:tsgo:"));
        if (mode !== "evidence") {
          expect(receipts).toEqual([]);
          if (mode === "unknown") {
            expect(result.stderr).toContain("unclassified compiler failure");
          }
          continue;
        }
        expect(receipts).toHaveLength(3);
        const leaves = receipts.slice(0, 2).map(
          (line) =>
            JSON.parse(line.slice(line.indexOf(" ") + 1)) as {
              id: string;
              config: string;
              exitCode: number;
              stdout: string;
              stderr: string;
            },
        );
        expect(
          leaves.map(({ config, exitCode, stderr }) => ({ config, exitCode, stderr })),
        ).toEqual([
          { config: "test/tsconfig/tsconfig.core.test.agents-other.json", exitCode: 2, stderr: "" },
          { config: "test/tsconfig/tsconfig.core.test.agents-tools.json", exitCode: 2, stderr: "" },
        ]);
        expect(leaves[0]!.stdout).toContain("leaf.test.ts(1,14): error TS2322");
        expect(leaves[1]!.stdout).toContain("consumer.test.ts(1,26): error TS2307");
        expect(JSON.parse(receipts[2]!.slice(receipts[2]!.indexOf(" ") + 1))).toEqual({
          version: 1,
          id: expect.any(String),
          planned: 2,
          completed: 2,
          leaves: leaves.map(({ id: leafId }) => leafId),
        });
        expect(fs.readdirSync(path.join(root, ".artifacts/dist-artifacts.lock"))).toEqual([]);
      }
      // Target only the boundary owner PID; its managed compiler must forward and join its group.
      const receiptClient = write(
        "compiler-receipts.mjs",
        `${fixtureReceiptClientSource(fixtureReceipts.endpoint)}
export { sendReceipt };
`,
      );
      write(
        "node_modules/.bin/tsgo",
        `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(0)); process.send('ready'); setInterval(()=>{},1000);"],{stdio:['ignore','ignore','ignore','ipc']});
let terminating=false;
const finish=()=>{if(terminating && (child.exitCode!==null || child.signalCode!==null)){fs.writeFileSync('compiler.joined','joined');process.exit(0);}};
child.once('exit',finish);
process.on('SIGTERM',()=>{terminating=true;fs.writeFileSync('compiler.signal','SIGTERM');finish();});
child.once('message',async()=>{child.disconnect();const {sendReceipt}=await import(${JSON.stringify(pathToFileURL(receiptClient).href)});fs.writeFileSync('compiler.pid',String(process.pid));fs.writeFileSync('descendant.pid',String(child.pid));sendReceipt(${JSON.stringify(root)},'ready');});
setInterval(()=>{},1000);
`,
      );
      let ownerPid: number | undefined;
      const cancel = new AbortController();
      const running = lifetime.track(
        runNodeScript(
          [
            "--import",
            pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href,
            driver,
            ...changedArgs([leaf]),
          ],
          env,
          undefined,
          {
            cwd: root,
            signal: AbortSignal.any([signal, cancel.signal]),
            requireProcessTreeExit: true,
            onReady(child) {
              ownerPid = child.pid;
            },
          },
        ),
      );
      try {
        const readPids = () => {
          const readPid = (name: string) => {
            const file = path.join(root, name);
            const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : Number.NaN;
            if (!Number.isInteger(pid) || pid <= 0) {
              throw new Error(`timeout waiting for pid in ${file}`);
            }
            return pid;
          };
          return { compilerPid: readPid("compiler.pid"), descendantPid: readPid("descendant.pid") };
        };
        // The query captures compiler stdout. Its durable PID records precede the
        // separate receipt, so an early driver exit checks those same records.
        const { compilerPid, descendantPid } = await withinTest(
          Promise.race([
            fixtureReceipts.waitFor(root, "ready").then(readPids),
            running.then(readPids),
          ]),
          signal,
        );
        expect(ownerPid).toBeDefined();
        process.kill(ownerPid!, "SIGTERM");
        const canceled = await withinTest(running, signal);
        expect(canceled.error).toBeUndefined();
        expect(canceled.status).toBe(143);
        expect(canceled.stderr).toContain("interrupted by SIGTERM");
        expect(fs.readFileSync(path.join(root, "compiler.signal"), "utf8")).toBe("SIGTERM");
        expect(fs.readFileSync(path.join(root, "compiler.joined"), "utf8")).toBe("joined");
        expect(isProcessAlive(compilerPid)).toBe(false);
        expect(isProcessAlive(descendantPid)).toBe(false);
        expect(() => process.kill(-compilerPid, 0)).toThrow();
      } finally {
        cancel.abort();
        await running;
      }
    }),
);
