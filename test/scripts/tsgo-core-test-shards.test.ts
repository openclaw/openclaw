import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { afterEach, describe, expect, it } from "vitest";
import { readNativeTypeScriptConfig } from "../../scripts/lib/native-typescript-config.mts";
import {
  findOversizedTsgoCoreTestShards,
  findTsgoCoreTestShardViolations,
  selectChangedTsgoCoreTestShards,
  selectDistDependentTsgoCoreTestConfigs,
  needsTypedRuntimeDistPreparation,
  TSGO_CORE_GRAPHS,
  selectTsgoCoreTestShards,
  selectTsgoCoreTestStripe,
  TSGO_CORE_TEST_DIST_DEPENDENT_FILES,
  TSGO_CORE_TEST_SHARDS,
} from "../../scripts/lib/tsgo-core-test-shards.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForPidFile } from "../helpers/process-wait.js";
import { runNodeScript } from "../helpers/run-node-script.js";
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
      ["ui/src/pages/chat/chat-send-submit.test.ts", "ui-chat"],
      ["ui/src/pages/config/config-page.test.ts", "ui-pages"],
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

  it("pins every dist-dependent test to a shard that actually owns it", () => {
    // readNativeTypeScriptConfig throws on any config diagnostic, so a parse
    // error fails the test rather than yielding an empty root list.
    const roots = (config: string) =>
      readNativeTypeScriptConfig({ cwd: process.cwd(), configFileName: config }).fileNames.map(
        (file) => path.relative(process.cwd(), file).replaceAll(path.sep, "/"),
      );

    expect(TSGO_CORE_TEST_DIST_DEPENDENT_FILES.length).toBeGreaterThan(0);
    for (const { file, shard } of TSGO_CORE_TEST_DIST_DEPENDENT_FILES) {
      // The file must exist on disk so a rename cannot silently orphan the entry.
      expect(fs.existsSync(path.resolve(file)), file).toBe(true);
      const owner = TSGO_CORE_TEST_SHARDS.find((entry) => entry.name === shard);
      expect(owner, `unknown owner shard ${shard}`).toBeDefined();
      // The named owner shard must resolve to include the dist-dependent file, and
      // the boundary check above guarantees no other shard also owns it.
      expect(roots(owner!.config), `${shard} must own ${file}`).toContain(file);
      // The selector reports the owner's config only when that shard is selected.
      expect(selectDistDependentTsgoCoreTestConfigs([owner!])).toEqual([owner!.config]);
    }
    // A shard that owns no dist-dependent file triggers no build.
    const ownerNames = new Set(TSGO_CORE_TEST_DIST_DEPENDENT_FILES.map((entry) => entry.shard));
    const independent = TSGO_CORE_TEST_SHARDS.filter((shard) => !ownerNames.has(shard.name));
    expect(selectDistDependentTsgoCoreTestConfigs(independent)).toEqual([]);
  });

  it("reports the dist-dependent owner config only when its shard is selected", () => {
    const ownerName = TSGO_CORE_TEST_DIST_DEPENDENT_FILES[0]!.shard;
    const owners = TSGO_CORE_TEST_SHARDS.filter((shard) => shard.name === ownerName);
    const independent = TSGO_CORE_TEST_SHARDS.filter((shard) => shard.name !== ownerName);
    expect(owners).toHaveLength(1);
    const owner = owners[0]!;

    expect(selectDistDependentTsgoCoreTestConfigs([])).toEqual([]);
    expect(selectDistDependentTsgoCoreTestConfigs(independent)).toEqual([]);
    expect(selectDistDependentTsgoCoreTestConfigs([owner])).toEqual([owner.config]);
    // A stripe that repeats the owner plans one preparation pass per shard config,
    // not one per selected entry.
    expect(selectDistDependentTsgoCoreTestConfigs([owner, owner])).toEqual([owner.config]);
    expect(selectDistDependentTsgoCoreTestConfigs([...independent, owner])).toEqual([owner.config]);
  });

  it("prepares the typed runtime only for a selected owner whose file exists", () => {
    const ownerName = TSGO_CORE_TEST_DIST_DEPENDENT_FILES[0]!.shard;
    const owner = TSGO_CORE_TEST_SHARDS.find((shard) => shard.name === ownerName)!;
    const independent = TSGO_CORE_TEST_SHARDS.filter((shard) => shard.name !== ownerName);
    const present = () => true;
    const absent = () => false;

    expect(needsTypedRuntimeDistPreparation([], present)).toBe(false);
    // A selection that owns no dist-dependent test never starts a build.
    expect(needsTypedRuntimeDistPreparation(independent, present)).toBe(false);
    // Synthetic fixtures select shards without carrying the real test file, so a
    // selection that matches on names alone must not start a build either.
    expect(needsTypedRuntimeDistPreparation([owner], absent)).toBe(false);
    expect(needsTypedRuntimeDistPreparation(TSGO_CORE_TEST_SHARDS, absent)).toBe(false);
    expect(needsTypedRuntimeDistPreparation([owner], present)).toBe(true);
    expect(needsTypedRuntimeDistPreparation(TSGO_CORE_TEST_SHARDS, present)).toBe(true);
    // The real checkout carries the file, so the owner selection prepares there.
    expect(
      needsTypedRuntimeDistPreparation([owner], (file) => fs.existsSync(path.resolve(file))),
    ).toBe(true);
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
afterEach(() => lifetime.cleanup());

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
      const compiler = write(
        "node_modules/.bin/tsgo",
        `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(),'compiler-events.jsonl'),JSON.stringify(args)+'\\n');
const result=spawnSync(${JSON.stringify(native)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
      );
      fs.chmodSync(compiler, 0o755);
      overrideNativeFixtureExecutable(root, compiler);
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
        write("compiler-events.jsonl", "");
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
        const calls = fs
          .readFileSync(path.join(root, "compiler-events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
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
      const renamed = await check([leaf, "src/agents/old.test.ts"], "2/5");
      expect(renamed.result.status, renamed.result.stderr).toBe(0);
      expect(renamed.builds).toEqual(selectTsgoCoreTestStripe("2/5")!.map((shard) => shard.config));
      // Stripe 1/5 selects the dist-dependent owner shard, but the fixture carries
      // no dist-dependent test, so the launcher must not start a preparation build
      // inside the temp root.
      const renamedOwner = await check([leaf, "src/agents/old.test.ts"], "1/5");
      expect(renamedOwner.result.status, renamedOwner.result.stderr).toBe(0);
      expect(renamedOwner.builds).toEqual(
        selectTsgoCoreTestStripe("1/5")!.map((shard) => shard.config),
      );
      expect(renamedOwner.builds).toContain(
        TSGO_CORE_TEST_SHARDS.find(
          (shard) => shard.name === TSGO_CORE_TEST_DIST_DEPENDENT_FILES[0]!.shard,
        )!.config,
      );
      expect(renamedOwner.result.stdout + renamedOwner.result.stderr).not.toContain(
        "building typed runtime dist entries",
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
      // Target only the boundary owner PID; its managed compiler must forward and join its group.
      write(
        "node_modules/.bin/tsgo",
        `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(0)); process.send('ready'); setInterval(()=>{},1000);"],{stdio:['ignore','ignore','ignore','ipc']});
let terminating=false;
const finish=()=>{if(terminating && (child.exitCode!==null || child.signalCode!==null)){fs.writeFileSync('compiler.joined','joined');process.exit(0);}};
child.once('exit',finish);
process.on('SIGTERM',()=>{terminating=true;fs.writeFileSync('compiler.signal','SIGTERM');finish();});
child.once('message',()=>{child.disconnect();fs.writeFileSync('compiler.pid',String(process.pid));fs.writeFileSync('descendant.pid',String(child.pid));});
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
        const compilerPid = await waitForPidFile(path.join(root, "compiler.pid"), 5_000);
        const descendantPid = await waitForPidFile(path.join(root, "descendant.pid"), 5_000);
        expect(ownerPid).toBeDefined();
        process.kill(ownerPid!, "SIGTERM");
        const canceled = await running;
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
