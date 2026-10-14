import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
  expandUpdateFirstHopCompatLanes,
} from "../../scripts/lib/update-first-hop-lanes.mjs";
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
});

describe("frozen admission upgrade Docker aliases", () => {
  const companion = "scripts/e2e/lib/plugin-index-sqlite.mjs";

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

  it.each(["plugins-offline", "update-first-hop-compat"])(
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
        lanes: requestedLanes
          .filter((requested) => !omitted.includes(requested))
          .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
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

  it.each([reader, shell])(
    "rejects dirty executable %s before any dependent code runs at unchanged HEAD",
    (path) => {
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
});

describe("frozen admission entry", () => {
  it.each(["nested-tooling", "nested-selected"] as const)(
    "binds selected and fallback files to their actual checkout in %s layout",
    (layout) => {
      const scenario = "scripts/e2e/lib/release-typed-onboarding/scenario.sh";
      const f = fixture({ [scenario]: "selected scenario; never execute" }, true, layout);
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

  it.each(["unknown catalog", "dirty absent metadata"])(
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

  it.each([{ scenarios: "base acpx-openclaw-tools-bridge", allow: false, supported: true }])(
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

  it.each(["absent", "missing object"])(
    "rejects selected Codex manifest %s before the wrapper can mount it",
    (shape) => {
      const manifest = "extensions/codex/package.json";
      const f = fixture(
        shape === "absent" ? {} : { [manifest]: '{"name":"@openclaw/codex"}' },
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

  it.each(["run.sh"])("rejects the selected survivor directory missing %s", (path) => {
    const files = survivorFiles();
    delete files[`scripts/e2e/lib/upgrade-survivor/${path}`];
    const f = fixture(files);
    const result = f.run({ consumers: ["upgrade-survivor"] });
    expectRejected(result, "missing required contract file");
  });

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
