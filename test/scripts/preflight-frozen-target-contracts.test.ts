import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
  expandUpdateFirstHopCompatLanes,
} from "../../scripts/lib/update-first-hop-lanes.mjs";
import { copyTreeCloseOnExec } from "../helpers/close-on-exec-copy.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const repo = resolve(".");
const entrypoint = "scripts/preflight-frozen-target-contracts.mjs";
const closure = [
  entrypoint,
  "scripts/lib/frozen-target-workflow-request.mjs",
  "scripts/lib/release-upgrade-baseline.mjs",
  "scripts/lib/canonical-json.mjs",
  "scripts/lib/docker-e2e-plan.mts",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/official-external-provider-catalog.json",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/update-compat-inventory.json",
  "scripts/lib/update-first-hop-lanes.mjs",
  "scripts/lib/upgrade-survivor-policy.mjs",
  "scripts/lib/upgrade-survivor-scenarios.json",
  "scripts/lib/release-version.mjs",
  "scripts/lib/frozen-target-source.mjs",
  "scripts/lib/frozen-target-compat.sh",
  "scripts/lib/trusted-native-typescript.mjs",
  "scripts/lib/native-typescript.mts",
  "scripts/resolve-frozen-codex-live-suite.mjs",
  "scripts/resolve-fs-safe-native-contract.mjs",
  "scripts/e2e/lib/upgrade-survivor/config-recipe.mts",
  "scripts/windows-cmd-helpers.mjs",
  "package.json",
  "pnpm-lock.yaml",
];

function commit(root: string, excluded: string[] = []) {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-q");
  git("add", "--", ".", ...excluded.map((path) => `:(exclude)${path}`));
  git("commit", "-qm", "fixture");
  return { root, sha: git("rev-parse", "HEAD"), git };
}

function removeBlob(source: ReturnType<typeof commit>, path: string) {
  const oid = source.git("rev-parse", `${source.sha}:${path}`);
  rmSync(join(source.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
  return oid;
}

function configureUnavailablePromisor(source: ReturnType<typeof commit>) {
  source.git("config", "remote.origin.url", "fixture::unavailable");
  source.git("config", "remote.origin.promisor", "true");
  source.git("config", "extensions.partialClone", "origin");
  source.git("config", "protocol.fixture.allow", "always");
}

function expectRejected(result: SpawnSyncReturns<string>, error?: string) {
  expect(result.status, result.stderr).toBe(1);
  if (error) {
    expect(result.stderr).toContain(error);
  }
  expect(result.stdout).toBe("");
}

function fixture(
  files: Record<string, string> = {},
  parser = false,
  support = false,
  layout: "siblings" | "nested-tooling" | "nested-selected" = "siblings",
) {
  const root = temps.make("openclaw-frozen-admission-");
  const toolingRoot = join(root, ".release-harness");
  const selectedRoot =
    layout === "nested-tooling"
      ? root
      : join(layout === "nested-selected" ? toolingRoot : root, "selected");
  mkdirSync(selectedRoot, { recursive: true });
  for (const file of closure) {
    const dest = join(toolingRoot, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(repo, file), dest);
  }
  const recipes = "scripts/e2e/lib/upgrade-survivor/config-recipe";
  cpSync(join(repo, recipes), join(toolingRoot, recipes), { recursive: true });
  if (support) {
    cpSync(join(repo, "scripts/e2e/lib"), join(toolingRoot, "scripts/e2e/lib"), {
      recursive: true,
    });
    for (const file of [
      "update-compat-contract.mjs",
      "openclaw-e2e-instance.sh",
      "docker-e2e-watchdog.mjs",
      "direct-run.mjs",
    ]) {
      copyFileSync(join(repo, "scripts/lib", file), join(toolingRoot, "scripts/lib", file));
    }
  }
  for (const [file, value] of Object.entries({
    "package.json": '{"type":"module","version":"2026.8.35"}',
    ...files,
  })) {
    mkdirSync(dirname(join(selectedRoot, file)), { recursive: true });
    writeFileSync(join(selectedRoot, file), value);
  }
  const selected = commit(selectedRoot, layout === "nested-tooling" ? [".release-harness"] : []);
  const tooling = commit(toolingRoot, layout === "nested-selected" ? ["selected"] : []);
  if (parser) {
    const installedParser = createRequire(import.meta.url).resolve("typescript/package.json");
    const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
    const installedNative = createRequire(installedParser).resolve(`${nativeName}/package.json`);
    copyTreeCloseOnExec(dirname(installedParser), join(toolingRoot, "node_modules/typescript"), {
      dereference: true,
    });
    copyTreeCloseOnExec(dirname(installedNative), join(toolingRoot, "node_modules", nativeName), {
      dereference: true,
    });
  }
  const log = join(root, "forbidden-commands");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git-remote-fixture"),
    `#!/bin/sh\nprintf 'hydration\\n' >> '${log}'\nexit 97\n`,
    { mode: 0o755 },
  );
  for (const command of ["npm", "pnpm", "npx", "tsx", "docker", "curl", "wget", "gh", "ghx"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${log}'\nexit 91\n`,
      { mode: 0o755 },
    );
  }
  const request = {
    version: 1,
    repository: "openclaw/openclaw",
    selected: { root: selected.root, sha: selected.sha },
    tooling: { root: tooling.root, sha: tooling.sha },
    allowFrozenTargetScenarioOmissions: true,
    selection: {},
  };
  function run(selection: object, overrides: object = {}, entry = join(toolingRoot, entrypoint)) {
    const input = join(root, "request.json");
    writeFileSync(input, JSON.stringify({ ...request, selection, ...overrides }));
    const result = spawnSync(process.execPath, [entry, input], {
      cwd: selectedRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, LANG: "C.UTF-8" },
    });
    expect(existsSync(log), result.stderr).toBe(false);
    return result;
  }
  return { root, selected, tooling, run, bin };
}

function survivorFiles(version = "2026.8.35", recipe = "config-recipe.mts") {
  const dir = "scripts/e2e/lib/upgrade-survivor";
  const inertModule = [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("selected-code-executed", "executed");',
    'throw new Error("selected scenario executed");',
  ].join("\n");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module", version }),
    [`${dir}/run.sh`]: "printf executed > selected-code-executed\nexit 97\n",
    [`${dir}/assertions.mjs`]: inertModule,
    [`${dir}/probe-gateway.mjs`]: inertModule,
    [`${dir}/${recipe}`]: inertModule,
  };
  for (const section of [
    "agents",
    "channels-discord",
    "channels-feishu",
    "channels-matrix",
    "channels-telegram",
    "channels-whatsapp",
    "gateway",
    "models-openai",
    "plugins-configured-installs",
    "plugins-feishu",
    "plugins",
    "skills",
  ]) {
    files[`${dir}/config-recipe/${section}.json`] = "{}";
  }
  for (const path of [
    "scripts/lib/npm-publish-plan.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/e2e/lib/plugin-index-sqlite.mjs",
    "scripts/e2e/lib/env-limits.mjs",
    "scripts/e2e/lib/text-file-utils.mjs",
  ]) {
    files[path] = `// ${path}\n${inertModule}`;
  }
  return files;
}

describe("frozen admission Docker consumer aliases", () => {
  const pluginAssertions = "scripts/e2e/lib/plugins/assertions.mjs";
  const aliases = ["mcp-channels", "kitchen-sink-rpc", "plugins-offline"].map((lane) => ({
    lane,
    consumer: "plugins",
    path: pluginAssertions,
    current: "export function assertPluginUninstallConfigState() {}",
    legacy: "export function assertPluginTgzRemoved() {}",
    mode: "OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE",
  }));
  const executionSentinel = [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(`${process.env.HOME}/selected-code-executed`, "executed");',
  ].join("\n");
  const consumerAliases = aliases.filter(({ lane }) => lane === "mcp-channels");

  it.each(consumerAliases)(
    "rejects a missing committed $lane contract before emitting admission",
    ({ lane, path, current }) => {
      const source = `${executionSentinel}\n${current}\n`;
      const f = fixture({ [path]: source });
      const tree = f.selected.git("rev-parse", "HEAD^{tree}");
      configureUnavailablePromisor(f.selected);
      removeBlob(f.selected, path);
      expect(f.selected.git("rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(readFileSync(join(f.selected.root, path), "utf8")).toBe(source);

      const result = f.run({ docker: { lanes: [lane] } });
      expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
      expectRejected(result, "unable to read selected source");

      const currentOnly = f.run(
        { docker: { lanes: [lane] } },
        { allowFrozenTargetScenarioOmissions: false },
      );
      expect(currentOnly.status, currentOnly.stderr).toBe(0);
      expect(JSON.parse(currentOnly.stdout).sources.selected).toEqual([]);
      expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
    },
  );

  it.each([
    ...aliases.map((alias) => Object.assign({}, alias, { dialect: "current" as const })),
    ...consumerAliases.map((alias) => Object.assign({}, alias, { dialect: "legacy" as const })),
  ])("admits $lane with the committed $dialect contract", (alias) => {
    const { lane, consumer, path, mode, dialect } = alias;
    const f = fixture({ [path]: `${executionSentinel}\n${alias[dialect]}\n` });
    const result = f.run({ docker: { lanes: [lane] } });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker).toEqual({ lanes: [lane], omitted: [], status: "ADMITTED" });
    expect(record.selection.consumers).toEqual([consumer]);
    expect(record.contracts).toEqual([
      {
        consumer,
        status: "ADMITTED",
        modes: { [mode]: dialect },
        files: [],
      },
    ]);
    expect(record.selectedSha).toBe(f.selected.sha);
    expect(record.toolingSha).toBe(f.tooling.sha);
    expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
    expect(existsSync(join(f.selected.root, "node_modules"))).toBe(false);
    expect(existsSync(join(f.tooling.root, "node_modules"))).toBe(false);
  });

  it.each(consumerAliases)(
    "preserves the legitimate absent-file fallback for $lane",
    ({ lane, consumer, mode }) => {
      const f = fixture();
      const result = f.run({ docker: { lanes: [lane] } });
      expect(result.status, result.stderr).toBe(0);
      const record = JSON.parse(result.stdout);
      expect(record.contracts).toEqual([
        {
          consumer,
          status: "ADMITTED",
          modes: { [mode]: "current" },
          files: [],
        },
      ]);
      expect(record.sources.selected).toEqual([]);
    },
  );

  it("deduplicates plugin aliases without selecting kitchen-sink-plugin files", () => {
    const f = fixture({
      [pluginAssertions]: `${executionSentinel}\nexport function assertPluginTgzRemoved() {}\n`,
    });
    const result = f.run({
      docker: { lanes: ["mcp-channels", "kitchen-sink-rpc", "plugins-offline"] },
    });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker.lanes.toSorted()).toEqual([
      "kitchen-sink-rpc",
      "mcp-channels",
      "plugins-offline",
    ]);
    expect(record.selection.consumers).toEqual(["plugins"]);
    expect(record.contracts).toEqual([
      {
        consumer: "plugins",
        status: "ADMITTED",
        modes: {
          OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE: "legacy",
        },
        files: [],
      },
    ]);
    expect(record.selectedSha).toBe(f.selected.sha);
    for (const source of [f.selected, f.tooling]) {
      expect(existsSync(join(source.root, "scripts/e2e/lib/kitchen-sink-plugin"))).toBe(false);
    }
    expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
  });

  it.each([
    { lane: "live-gateway", removed: [pluginAssertions], consumer: null },
    { lane: "docker-package-install", removed: [pluginAssertions], consumer: null },
  ])("keeps unreadable unrelated contracts inert for $lane", ({ lane, removed, consumer }) => {
    const f = fixture({
      [pluginAssertions]: `${executionSentinel}\nexport function assertPluginUninstallConfigState() {}\n`,
    });
    for (const path of removed) {
      removeBlob(f.selected, path);
    }
    const result = f.run({ docker: { lanes: [lane] } });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker).toEqual({ lanes: [lane], omitted: [], status: "ADMITTED" });
    expect(record.selection.consumers).toEqual(consumer ? [consumer] : []);
    expect(record.contracts.map((contract: { consumer: string }) => contract.consumer)).toEqual(
      consumer ? [consumer] : [],
    );
    expect(record.selectedSha).toBe(f.selected.sha);
    expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
  });
});

describe("frozen admission upgrade Docker aliases", () => {
  const lanes = ["root-managed-vps-upgrade", "update-restart-auth"];
  const companion = "scripts/e2e/lib/plugin-index-sqlite.mjs";
  const pluginAssertions = "scripts/e2e/lib/plugins/assertions.mjs";

  it.each([
    {
      shape: "malformed version",
      version: "invalid",
      error: "selected upgrade target has an invalid release version",
    },
    {
      shape: "unsupported correction",
      version: "2026.8.33-1",
      error: "unsupported extended-stable correction",
    },
    {
      shape: "missing scenario",
      version: "2026.8.33",
      error: "selected extended-stable target lacks its scenario",
    },
    {
      shape: "missing companion blob",
      version: "2026.8.33",
      error: "unable to read selected source",
    },
  ])("rejects an upgrade alias with $shape before admission", ({ shape, version, error }) => {
    const lane = "root-managed-vps-upgrade";
    const files =
      shape === "missing companion blob"
        ? survivorFiles(version)
        : { "package.json": JSON.stringify({ type: "module", version }) };
    const f = fixture(files);
    if (shape === "missing companion blob") {
      const tree = f.selected.git("rev-parse", "HEAD^{tree}");
      const oid = f.selected.git("rev-parse", `${f.selected.sha}:${companion}`);
      for (const path of Object.keys(files).filter((file) => file !== companion)) {
        expect(f.selected.git("rev-parse", `${f.selected.sha}:${path}`), path).not.toBe(oid);
      }
      configureUnavailablePromisor(f.selected);
      removeBlob(f.selected, companion);
      expect(f.selected.git("rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(readFileSync(join(f.selected.root, companion), "utf8")).toBe(files[companion]);
    }
    const result = f.run({ docker: { lanes: [lane] } });
    expectRejected(result, error);
    for (const root of [f.root, f.selected.root, f.tooling.root]) {
      expect(existsSync(join(root, "selected-code-executed"))).toBe(false);
    }
    const currentOnly = f.run(
      { docker: { lanes: [lane] } },
      { allowFrozenTargetScenarioOmissions: false },
    );
    expect(currentOnly.status, currentOnly.stderr).toBe(0);
    expect(JSON.parse(currentOnly.stdout).sources.selected).toEqual([]);
  });

  it.each([
    ...[
      { version: "2026.8.35", recipe: "config-recipe.mts", train: "extended-stable" },
      { version: "2026.9.9", recipe: "", train: "stable" },
    ].map((value) => Object.assign({}, value, { lane: "root-managed-vps-upgrade" })),
    { lane: "update-restart-auth", version: "2026.9.9", recipe: "", train: "stable" },
  ])("admits $lane with committed $version contracts", ({ lane, version, recipe, train }) => {
    const files = recipe
      ? survivorFiles(version, recipe)
      : { "package.json": JSON.stringify({ type: "module", version }) };
    const f = fixture({
      ...files,
      [pluginAssertions]: "throw new Error('unselected plugin code executed');",
    });
    removeBlob(f.selected, pluginAssertions);
    const result = f.run({ docker: { lanes: [lane] } });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker).toEqual({ lanes: [lane], omitted: [], status: "ADMITTED" });
    expect(record.selection.consumers).toEqual(["upgrade-survivor"]);
    expect(record.contracts).toHaveLength(1);
    expect(record.contracts[0].modes).toEqual({
      OPENCLAW_FROZEN_UPGRADE_SURVIVOR_TOOL_SEARCH_RECIPE: "absent",
      OPENCLAW_FROZEN_UPGRADE_SURVIVOR_MEMBERSHIP_MODE: "native",
      releaseTrain: train,
    });
    expect(record.selectedSha).toBe(f.selected.sha);
    expect(record.toolingSha).toBe(f.tooling.sha);
    expect(record.contracts[0].files).toHaveLength(recipe ? 5 : 0);
    if (recipe) {
      expect(record.contracts[0].files).toContainEqual({ source: "selected", path: companion });
    } else {
      expect(existsSync(join(f.selected.root, "scripts/e2e/lib/upgrade-survivor"))).toBe(false);
    }
    for (const root of [f.root, f.selected.root, f.tooling.root]) {
      expect(existsSync(join(root, "selected-code-executed"))).toBe(false);
      expect(existsSync(join(root, "node_modules"))).toBe(false);
    }
  });

  it("deduplicates upgrade aliases and existing family without dropping the plugin consumer", () => {
    const f = fixture({ "package.json": '{"type":"module","version":"2026.9.9"}' });
    const selected = [...lanes, "upgrade-survivor", "plugins-offline"];
    const result = f.run({ docker: { lanes: selected } });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker.lanes.toSorted()).toEqual(selected.toSorted());
    expect(record.selection.consumers).toEqual(["plugins", "upgrade-survivor"]);
    expect(record.contracts.map((contract: { consumer: string }) => contract.consumer)).toEqual([
      "plugins",
      "upgrade-survivor",
    ]);
  });

  it.each(["plugins-offline", "docker-package-install", "update-first-hop-compat"])(
    "keeps unselected upgrade contracts inert for %s",
    (lane) => {
      const files: Record<string, string> = {
        "package.json": '{"type":"module","version":"invalid"}',
        "src/infra/clawhub-install-trust.ts":
          "throw new Error('unselected upgrade code executed');",
        "scripts/print-cli-backend-live-metadata.ts":
          "throw new Error('unselected CLI code executed');",
      };
      if (lane === "update-first-hop-compat") {
        files["scripts/runtime-postbuild.mts"] =
          `throw new Error("selected postbuild executed");\n${readFileSync("scripts/runtime-postbuild.mts", "utf8")}`;
      }
      const f = fixture(files);
      for (const path of [
        "src/infra/clawhub-install-trust.ts",
        "scripts/print-cli-backend-live-metadata.ts",
      ]) {
        removeBlob(f.selected, path);
      }
      const requestedLanes = expandUpdateFirstHopCompatLanes([lane]);
      const result = f.run({ docker: { lanes: requestedLanes } });
      expect(result.status, result.stderr).toBe(0);
      const record = JSON.parse(result.stdout);
      const omitted =
        lane === "update-first-hop-compat" ? [UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE] : [];
      expect(record.docker).toEqual({
        lanes: requestedLanes.filter((requested) => !omitted.includes(requested)),
        omitted,
        status: "ADMITTED",
      });
      expect(record.selection.consumers).toEqual(lane === "plugins-offline" ? ["plugins"] : []);
      expect(record.contracts.map((contract: { consumer: string }) => contract.consumer)).toEqual(
        record.selection.consumers,
      );
    },
  );
});

describe("frozen admission bootstrap repairs", () => {
  const recipeDirectory = "scripts/e2e/lib/upgrade-survivor/config-recipe";
  const reader = "scripts/lib/frozen-target-source.mjs";
  const shell = "scripts/lib/frozen-target-compat.sh";

  it.each([
    reader,
    "scripts/lib/frozen-target-workflow-request.mjs",
    "scripts/lib/release-upgrade-baseline.mjs",
    "scripts/lib/release-version.mjs",
    "scripts/lib/canonical-json.mjs",
    "scripts/lib/docker-e2e-scenarios.mts",
    shell,
  ])("rejects dirty executable %s before any dependent code runs at unchanged HEAD", (path) => {
    const f = fixture({ "src/config/zod-schema.ts": "lastRunAt:" });
    const sentinel = join(f.root, "dependent-code-executed");
    const file = join(f.tooling.root, path);
    const payload =
      path === shell
        ? `\nprintf executed > '${sentinel}'\n`
        : `\n(await import("node:fs")).writeFileSync(${JSON.stringify(sentinel)}, "executed");\n`;
    writeFileSync(file, readFileSync(file, "utf8") + payload);
    expect(f.tooling.git("rev-parse", "HEAD")).toBe(f.tooling.sha);
    const result = f.run({ consumers: [] });
    expect(existsSync(sentinel), result.stderr).toBe(false);
    expectRejected(result, `tooling closure does not match committed source: ${path}`);
  });

  it.each([entrypoint, `${recipeDirectory}/agents.json`])(
    "rejects dirty closure data %s at unchanged HEAD",
    (path) => {
      const f = fixture();
      const file = join(f.tooling.root, path);
      writeFileSync(file, readFileSync(file, "utf8") + "\n");
      expect(f.tooling.git("rev-parse", "HEAD")).toBe(f.tooling.sha);
      const result = f.run({});
      expectRejected(result, `tooling closure does not match committed source: ${path}`);
    },
  );

  it.each(["file", "parent directory"] as const)(
    "rejects a tooling %s symlink even when its bytes match",
    (shape) => {
      const f = fixture();
      const path = shape === "file" ? reader : "scripts/e2e/lib/upgrade-survivor/config-recipe";
      const original = join(f.tooling.root, path);
      const outside = join(f.root, "borrowed");
      cpSync(original, outside, { recursive: true });
      rmSync(original, { recursive: true });
      symlinkSync(outside, original);
      const result = f.run({});
      expectRejected(result, "tooling closure requires an owned regular file:");
    },
  );

  it("records the verified closure while ignoring unrelated dirt and selected working bytes", () => {
    const source = "src/config/zod-schema.ts";
    const f = fixture({ [source]: "lastRunAt:" });
    writeFileSync(join(f.tooling.root, "unrelated.txt"), "committed");
    f.tooling.git("add", "unrelated.txt");
    f.tooling.git("commit", "-qm", "unrelated file");
    const sha = f.tooling.git("rev-parse", "HEAD");
    const overrides = { tooling: { root: f.tooling.root, sha } };
    const clean = f.run({ consumers: [] }, overrides);
    expect(clean.status, clean.stderr).toBe(0);
    writeFileSync(join(f.tooling.root, "unrelated.txt"), "dirty");
    writeFileSync(join(f.selected.root, source), "unrecognized working copy");
    const dirty = f.run({ consumers: [] }, overrides);
    expect(dirty.status, dirty.stderr).toBe(0);
    expect(dirty.stdout).toBe(clean.stdout);
    const paths = [
      ...closure,
      ...readdirSync(join(f.tooling.root, recipeDirectory)).map(
        (file) => `${recipeDirectory}/${file}`,
      ),
    ];
    expect(JSON.parse(dirty.stdout).sources.tooling).toEqual(
      paths
        .toSorted((a, b) => a.localeCompare(b))
        .map((path) => ({ path, oid: f.tooling.git("rev-parse", `${sha}:${path}`) })),
    );
  });

  it("retains the existing tooling HEAD mismatch rejection", () => {
    const f = fixture();
    f.tooling.git("commit", "--allow-empty", "-qm", "different HEAD");
    const result = f.run({});
    expectRejected(result, "checkout does not match OPENCLAW_SELECTED_SHA");
  });

  it.each([entrypoint, `${recipeDirectory}/agents.json`])(
    "rejects a missing committed tooling object %s without hydration",
    (path) => {
      const f = fixture();
      f.tooling.git("config", "remote.origin.url", "fixture::unavailable");
      f.tooling.git("config", "remote.origin.promisor", "true");
      removeBlob(f.tooling, path);
      const result = f.run({});
      expectRejected(result);
    },
  );

  it.each([
    entrypoint,
    "scripts/resolve-frozen-codex-live-suite.mjs",
    "scripts/resolve-fs-safe-native-contract.mjs",
  ])("runs %s through a symlink and stays inert when imported", (path) => {
    const f = fixture();
    const alias = join(f.root, "entry-alias.mjs");
    symlinkSync(join(f.tooling.root, path), alias);
    const output = join(f.root, "github-output");
    const env = {
      PATH: `${f.bin}:${process.env.PATH}`,
      HOME: f.root,
      GITHUB_OUTPUT: output,
      OPENCLAW_FROZEN_CODEX_SUITE_ID: "live-codex-harness-docker",
      OPENCLAW_SELECTED_SHA: f.selected.sha,
      OPENCLAW_WORKFLOW_SHA: f.tooling.sha,
    };
    const run = (args: string[], environment = env) =>
      spawnSync(process.execPath, args, {
        cwd: f.selected.root,
        encoding: "utf8",
        timeout: 20_000,
        env: environment,
      });
    const valid =
      path === entrypoint ? f.run({}, {}, alias) : run([alias, f.selected.sha, f.tooling.sha, "0"]);
    expect(valid.status, valid.stderr).toBe(0);
    if (path === entrypoint) {
      expect(JSON.parse(valid.stdout).toolingSha).toBe(f.tooling.sha);
    } else if (path.includes("codex")) {
      expect(existsSync(output)).toBe(true);
      expect(readFileSync(output, "utf8")).toBe("run_lane=true\n");
      rmSync(output);
    } else {
      expect(valid.stdout).toBe("required\n");
    }
    const invalid = run([alias], { ...env, GITHUB_OUTPUT: "" });
    expect(invalid.status, invalid.stderr).not.toBe(0);
    expect(invalid.stdout).toBe("");
    const imported = run([
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(alias).href)});`,
    ]);
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    "scripts/resolve-frozen-codex-live-suite.mjs",
    "scripts/resolve-fs-safe-native-contract.mjs",
  ])("preserves standalone sparse execution of %s without shared helpers", (path) => {
    const root = temps.make("openclaw-frozen-standalone-");
    const entry = join(root, "resolver.mjs");
    copyFileSync(join(repo, path), entry);
    const output = join(root, "github-output");
    const sha = "a".repeat(40);
    const result = spawnSync(process.execPath, [entry, sha, sha, "0"], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        OPENCLAW_FROZEN_CODEX_SUITE_ID: "live-codex-harness-docker",
        OPENCLAW_SELECTED_SHA: sha,
        OPENCLAW_WORKFLOW_SHA: sha,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(path.includes("codex") ? readFileSync(output, "utf8") : result.stdout).toBe(
      path.includes("codex") ? "run_lane=true\n" : "required\n",
    );
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(existsSync(join(root, "scripts"))).toBe(false);
  });
});

describe("frozen admission entry", () => {
  it.each<{
    name: string;
    files: Record<string, string>;
    allow: boolean;
    mode: "required" | "unsupported" | null;
  }>([
    { name: "legacy authorized", files: {}, allow: true, mode: "unsupported" },
    { name: "legacy strict", files: {}, allow: false, mode: "required" },
    {
      name: "current declaration regression",
      files: {
        "src/config/zod-schema.session-config.ts": "export const SessionSchema = z.object({});",
      },
      allow: true,
      mode: "required",
    },
    {
      name: "legacy backport",
      files: { "src/config/zod-schema.session.ts": "coldStorage: z.object({})" },
      allow: true,
      mode: "required",
    },
    {
      name: "unknown schema",
      files: { "src/config/zod-schema.session.ts": "unknown schema" },
      allow: true,
      mode: null,
    },
  ])("binds both cold subcases for $name", ({ files, allow, mode }) => {
    const f = fixture({
      "src/config/zod-schema.session.ts":
        "export const SessionSchema = z.object({ maintenance: z.object({ pruneAfter: PositiveDurationSchema.optional() }) });",
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts":
        "fragments?: RuntimeContextFragment[];\nconst fragments = params.fragments?.filter",
      ...files,
    });
    const result = f.run(
      { docker: { lanes: ["session-runtime-context", "openai-chat-tools"] } },
      { allowFrozenTargetScenarioOmissions: allow },
    );
    if (mode === null) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unable to resolve frozen session cold-storage contract");
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker.lanes).toEqual(["openai-chat-tools", "session-runtime-context"]);
    expect(
      record.contracts.map((contract: { consumer: string; modes: Record<string, string> }) => [
        contract.consumer,
        contract.modes.OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE,
      ]),
    ).toEqual([
      ["openai-chat-tools", mode],
      ["session-runtime-context", mode],
    ]);
  });

  it.each(["nested-tooling", "nested-selected"] as const)(
    "binds selected and fallback files to their actual checkout in %s layout",
    (layout) => {
      const scenario = "scripts/e2e/lib/release-typed-onboarding/scenario.sh";
      const f = fixture({ [scenario]: "selected scenario; never execute" }, false, true, layout);
      const result = f.run({ consumers: ["release-typed-onboarding"] });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).contracts[0].files).toEqual([
        { source: "selected", path: scenario },
        { source: "tooling", path: "scripts/e2e/lib/release-scenarios/assertions.mjs" },
        { source: "tooling", path: "scripts/e2e/lib/release-assertion-files.mjs" },
        { source: "tooling", path: "scripts/e2e/lib/fixtures/mock-openai-config.mjs" },
      ]);
    },
  );

  it("runs the real Node closure without dependencies and binds only selected contracts", () => {
    const f = fixture({
      "src/config/zod-schema.ts": "lastRunAt:",
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts": "unknown runtime contract",
      "scripts/e2e/lib/upgrade-survivor/assertions.mjs":
        "throw new Error('target command executed');",
    });
    const selection = { docker: { lanes: ["onboard", "docker-package-install"] } };
    const first = f.run(selection);
    expect(first.status, first.stderr).toBe(0);
    const record = JSON.parse(first.stdout);
    expect(record.contracts).toEqual([]);
    expect(record.docker.lanes).toEqual(["docker-package-install", "onboard"]);
    expect(record.selectedSha).toBe(f.selected.sha);
    expect(record.toolingSha).toBe(f.tooling.sha);
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.stdout).not.toContain(f.root);
    expect(first.stdout).not.toMatch(/"command"|"credentials"|"retries"/);
    expect(existsSync(join(f.selected.root, "node_modules"))).toBe(false);
    expect(existsSync(join(f.tooling.root, "node_modules"))).toBe(false);
    expect(f.run(selection).stdout).toBe(first.stdout);
    const invalid = f.run({ docker: { lanes: ["onboard", "session-runtime-context"] } });
    expectRejected(invalid, "unable to resolve frozen runtime-context");
  });

  it.each(["unknown catalog", "deleted blob", "dirty absent metadata"])(
    "fails or omits from committed source for %s without running target code",
    (shape) => {
      const relative =
        shape === "unknown catalog"
          ? "scripts/e2e/lib/upgrade-survivor/assertions.mjs"
          : "src/cli/update-cli/update-command-plugin-preflight.ts";
      const f = fixture(
        shape === "dirty absent metadata"
          ? {}
          : {
              [relative]: 'throw new Error("target body executed");',
            },
      );
      if (shape === "deleted blob") {
        configureUnavailablePromisor(f.selected);
        removeBlob(f.selected, relative);
      } else if (shape === "dirty absent metadata") {
        mkdirSync(dirname(join(f.selected.root, relative)), { recursive: true });
        writeFileSync(join(f.selected.root, relative), "dirty supported decoy");
      }
      const result = f.run({
        docker: {
          lanes: [
            shape === "unknown catalog" ? "published-upgrade-survivor" : "update-corrupt-plugin",
          ],
          baselines: "2026.6.11",
        },
      });
      if (shape === "dirty absent metadata") {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).docker).toEqual({
          lanes: [],
          omitted: ["update-corrupt-plugin"],
          status: "NOT RUN",
        });
      } else {
        expectRejected(
          result,
          shape === "unknown catalog" ? "inert scenario catalog" : "unable to read selected source",
        );
      }
    },
  );

  it.each([
    { scenarios: "acpx-openclaw-tools-bridge", allow: true, supported: false },
    { scenarios: "base acpx-openclaw-tools-bridge", allow: true, supported: true },
    { scenarios: "base acpx-openclaw-tools-bridge", allow: false, supported: true },
  ])(
    "preserves inert-only survivor coverage for $scenarios with omissions $allow",
    ({ scenarios, allow, supported }) => {
      const catalog = [
        "base",
        "feishu-channel",
        "bootstrap-persona",
        "channel-post-core-restore",
        "plugin-deps-cleanup",
        "configured-plugin-installs",
        "stale-source-plugin-shadow",
        "tilde-log-path",
        "versioned-runtime-deps",
      ];
      const f = fixture({
        "package.json": '{"version":"2026.9.9"}',
        "scripts/e2e/lib/upgrade-survivor/assertions.mjs": [
          "const SCENARIOS = new Set([",
          ...catalog.map((scenario) => `  "${scenario}",`),
          "]);",
          'throw new Error("target catalog executed");',
        ].join("\n"),
      });
      const result = f.run(
        {
          docker: {
            lanes: ["published-upgrade-survivor"],
            baselines: "2026.6.11",
            scenarios,
          },
        },
        { allowFrozenTargetScenarioOmissions: allow },
      );
      if (!allow) {
        expectRejected(result, "require authorized scenario omissions");
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      const record = JSON.parse(result.stdout);
      expect(record.docker).toEqual({
        lanes: supported ? ["published-upgrade-survivor-2026.6.11"] : [],
        omitted: ["published-upgrade-survivor-2026.6.11-acpx-openclaw-tools-bridge"],
        status: supported ? "ADMITTED" : "NOT RUN",
      });
      expect(record.contracts.map((contract: { consumer: string }) => contract.consumer)).toEqual(
        supported ? ["upgrade-survivor"] : [],
      );
    },
  );

  it("admits the current JSON catalog through the dependency-free cold entry", () => {
    const catalogPath = "scripts/lib/upgrade-survivor-scenarios.json";
    const assertionsPath = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";
    const policyPath = "scripts/lib/upgrade-survivor-policy.mjs";
    const sentinelCode = '\nthrow new Error("selected module must not execute");\n';
    const f = fixture({
      "package.json": '{"version":"2026.9.9"}',
      [catalogPath]: readFileSync(catalogPath, "utf8"),
      [assertionsPath]: readFileSync(assertionsPath, "utf8") + sentinelCode,
      [policyPath]: readFileSync(policyPath, "utf8") + sentinelCode,
    });
    writeFileSync(
      join(f.selected.root, catalogPath),
      "dirty data must not replace committed catalog",
    );
    expect(existsSync(join(f.tooling.root, "node_modules"))).toBe(false);
    expect(existsSync(join(f.selected.root, "node_modules"))).toBe(false);
    const result = f.run({
      docker: { lanes: ["published-upgrade-survivor"], baselines: "2026.9.4", scenarios: "base" },
    });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker).toEqual({
      lanes: ["published-upgrade-survivor-2026.9.4"],
      omitted: [],
      status: "ADMITTED",
    });
    expect(record.sources.selected).toContainEqual({
      path: catalogPath,
      oid: f.selected.git("rev-parse", `${f.selected.sha}:${catalogPath}`),
    });
    expect(existsSync(join(f.tooling.root, "node_modules"))).toBe(false);
    expect(existsSync(join(f.selected.root, "node_modules"))).toBe(false);
  });

  it("shares the Codex and fs-safe cores while preserving source read errors", () => {
    const catalog = "extensions/codex/provider-catalog.ts";
    const f = fixture({
      "package.json": '{"version":"2026.8.35","dependencies":{"@openclaw/fs-safe":"0.5.6"}}',
      [catalog]:
        'export const FALLBACK_CODEX_MODELS = [{ id: "gpt-5.5" }] satisfies unknown[];\nthrow new Error("catalog executed");',
      "src/infra/fs-safe-defaults.ts":
        'import { configureFsSafeNative } from "@openclaw/fs-safe/config";',
    });
    f.selected.git("update-ref", "refs/remotes/origin/extended-stable/2026.8.33", f.selected.sha);
    const selection = {
      codexSuites: ["live-codex-harness-docker", "live-codex-harness-gpt56-sol-docker"],
      fsSafeNative: true,
    };
    const result = f.run(selection);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).contracts).toEqual([
      { consumer: "live-codex-harness-docker", status: "ADMITTED", model: "openai/gpt-5.5" },
      { consumer: "live-codex-harness-gpt56-sol-docker", status: "NOT RUN" },
      { consumer: "fs-safe-native", mode: "bundled" },
    ]);
    removeBlob(f.selected, catalog);
    const rejected = f.run(selection);
    expectRejected(rejected, "unable to read selected source");
    expect(f.run(selection, { allowFrozenTargetScenarioOmissions: false }).status).toBe(0);
  });

  it.each([
    { dependency: "0.18.2", version: "2026.9.33", requiresDefaults: false },
    { dependency: "0.5.6", version: "2026.8.33", requiresDefaults: true },
  ])(
    "retains the fs-safe $dependency contract when the defaults shim is absent",
    ({ dependency, version, requiresDefaults }) => {
      const f = fixture({
        "package.json": JSON.stringify({
          version,
          dependencies: { "@openclaw/fs-safe": dependency },
        }),
      });
      f.selected.git(
        "update-ref",
        `refs/remotes/origin/extended-stable/${version}`,
        f.selected.sha,
      );
      const result = f.run({ fsSafeNative: true });
      if (requiresDefaults) {
        expectRejected(result, "missing fs-safe defaults source");
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).contracts).toEqual([
          { consumer: "fs-safe-native", mode: "required" },
        ]);
      }
    },
  );

  it.each([
    "npm-onboard-channel-agent",
    "codex-on-demand",
    "kitchen-sink-plugin",
    "update-corrupt-plugin",
  ])("matches the real %s wrapper file mounts and propagates a missing companion", (consumer) => {
    const files = {
      "npm-onboard-channel-agent": [
        "scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs",
        "scripts/e2e/lib/fixtures/mock-openai-config.mjs",
      ],
      "codex-on-demand": ["scripts/e2e/lib/codex-on-demand/assertions.mjs"],
      "kitchen-sink-plugin": ["scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs"],
      "update-corrupt-plugin": ["scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh"],
    }[consumer]!;
    const pluginAssertions = "scripts/e2e/lib/plugins/assertions.mjs";
    const codexManifest = "extensions/codex/package.json";
    const f = fixture(
      {
        ...Object.fromEntries(files.map((file) => [file, "selected fixture, not executable"])),
        ...(consumer === "codex-on-demand"
          ? { [codexManifest]: '{"name":"@openclaw/codex","version":"2026.8.35"}' }
          : {}),
        ...(consumer === "kitchen-sink-plugin"
          ? { [pluginAssertions]: "function assertPluginTgzRemoved() {}" }
          : {}),
      },
      false,
      true,
    );
    const admitted = f.run({ consumers: [consumer] });
    expect(admitted.status, admitted.stderr).toBe(0);
    const contract = JSON.parse(admitted.stdout).contracts[0];
    const resolved = contract.files;
    expect(resolved).toEqual([
      ...files.map((path) => ({ source: "selected", path })),
      ...(consumer === "codex-on-demand"
        ? [null, { source: "selected", path: codexManifest }]
        : []),
    ]);
    const dockerLog = join(f.root, "docker.args");
    const packageFile = join(f.root, "fixture.tgz");
    writeFileSync(packageFile, "recording fixture never opens this package");
    // Kitchen-sink owns post-container resource assertions outside this mount proof.
    const stopAtRun = consumer === "kitchen-sink-plugin" ? '[ "$1" != run ] || exit 73\n' : "";
    writeFileSync(
      join(f.bin, "docker"),
      `#!/bin/sh\nprintf '%s\\0' "$@" >> '${dockerLog}'\n${stopAtRun}exit 0\n`,
      { mode: 0o755 },
    );
    const execution = spawnSync("bash", [join(repo, `scripts/e2e/${consumer}-docker.sh`)], {
      cwd: repo,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${f.bin}:${process.env.PATH}`,
        HOME: f.root,
        TMPDIR: f.root,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
        OPENCLAW_SELECTED_SHA: f.selected.sha,
        OPENCLAW_TOOLING_SHA: f.tooling.sha,
        OPENCLAW_DOCKER_E2E_REPO_ROOT: f.selected.root,
        OPENCLAW_CURRENT_PACKAGE_TGZ: packageFile,
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
      },
    });
    expect(execution.status, execution.stderr).toBe(consumer === "kitchen-sink-plugin" ? 73 : 0);
    const args = readFileSync(dockerLog, "utf8").split("\0");
    for (const path of files) {
      expect(args).toContain(`${f.selected.root}/${path}:/app/${path}:ro`);
    }
    if (consumer === "codex-on-demand") {
      expect(args).toContain("OPENCLAW_CODEX_DOCTOR_CHECKS_ENABLED=0");
      expect(args).toContain(
        `${f.selected.root}/${codexManifest}:/tmp/openclaw-candidate-codex-package.json:ro`,
      );
      expect(JSON.parse(admitted.stdout).sources.selected).toContainEqual({
        path: codexManifest,
        oid: f.selected.git("rev-parse", `${f.selected.sha}:${codexManifest}`),
      });
    }
    if (consumer === "kitchen-sink-plugin") {
      expect(args).toContain("OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE=legacy");
      expect(contract.modes.OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE).toBe("legacy");
      const capabilityOid = removeBlob(f.selected, pluginAssertions);
      const unreadable = f.run({ consumers: [consumer] });
      expectRejected(unreadable, "unable to read selected source");
      expect(f.run({ consumers: [] }).status).toBe(0);
      expect(f.selected.git("hash-object", "-w", pluginAssertions)).toBe(capabilityOid);
    }
    removeBlob(f.selected, files[0]!);
    const rejected = f.run({ consumers: [consumer] });
    expectRejected(rejected, "unable to read selected source");
  });

  it.each(["absent", "missing object"])(
    "rejects selected Codex manifest %s before the wrapper can mount it",
    (shape) => {
      const manifest = "extensions/codex/package.json";
      const f = fixture(
        shape === "absent" ? {} : { [manifest]: '{"name":"@openclaw/codex"}' },
        false,
        true,
      );
      if (shape === "missing object") {
        removeBlob(f.selected, manifest);
      }
      for (const allow of [true, false]) {
        const result = f.run(
          { consumers: ["codex-on-demand"] },
          { allowFrozenTargetScenarioOmissions: allow },
        );
        expectRejected(
          result,
          shape === "absent" ? "missing required contract file" : "unable to read selected source",
        );
      }
      expect(f.run({ consumers: [] }).status).toBe(0);
    },
  );

  it.each(["run.sh", "config-recipe/models-openai.json"])(
    "rejects the selected survivor directory missing %s",
    (path) => {
      const files = survivorFiles();
      delete files[`scripts/e2e/lib/upgrade-survivor/${path}`];
      const f = fixture(files);
      const result = f.run({ consumers: ["upgrade-survivor"] });
      expectRejected(result, "missing required contract file");
    },
  );

  it.each([
    { selection: { consumers: ["invented"] } },
    { selection: { docker: { lanes: ["not-a-lane"] } } },
    { selection: { commands: ["npm install"] } },
    { allowFrozenTargetScenarioOmissions: "1" },
    { repository: "untrusted/other" },
    { selected: { root: ".", sha: "short" } },
  ])("rejects malformed or widened admission input %#", (overrides) => {
    const f = fixture();
    const result = f.run({}, overrides);
    expectRejected(result);
  });
});
