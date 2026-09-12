import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const repo = resolve(".");
const entrypoint = "scripts/preflight-frozen-target-contracts.mjs";
const closure = [
  entrypoint,
  "scripts/lib/docker-e2e-plan.mts",
  "scripts/lib/docker-e2e-scenarios.mts",
  "scripts/lib/official-external-channel-catalog.json",
  "scripts/lib/upgrade-survivor-policy.mjs",
  "scripts/lib/release-version.mjs",
  "scripts/lib/frozen-target-source.mjs",
  "scripts/lib/frozen-target-compat.sh",
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
      "record-shared.mjs",
      "update-compat-contract.mjs",
      "openclaw-e2e-instance.sh",
      "direct-run.mjs",
    ]) {
      copyFileSync(join(repo, "scripts/lib", file), join(toolingRoot, "scripts/lib", file));
    }
  }
  for (const [file, value] of Object.entries({
    "package.json": '{"type":"module","version":"2026.7.33"}',
    ...files,
  })) {
    mkdirSync(dirname(join(selectedRoot, file)), { recursive: true });
    writeFileSync(join(selectedRoot, file), value);
  }
  const selected = commit(selectedRoot, layout === "nested-tooling" ? [".release-harness"] : []);
  const tooling = commit(toolingRoot, layout === "nested-selected" ? ["selected"] : []);
  if (parser) {
    cpSync(join(repo, "node_modules/typescript"), join(toolingRoot, "node_modules/typescript"), {
      recursive: true,
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

function survivorFiles(version = "2026.7.33", recipe = "config-recipe.mjs") {
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
  const cliMetadata = "scripts/print-cli-backend-live-metadata.ts";
  const pluginAssertions = "scripts/e2e/lib/plugins/assertions.mjs";
  const aliases = [
    {
      lane: "live-gateway",
      consumer: "live-cli-backend",
      path: cliMetadata,
      current: "export function resolveCliBackendDockerPackages() {}",
      legacy: "// Released metadata without the package resolver.",
      mode: "OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE",
    },
    ...["mcp-channels", "kitchen-sink-rpc", "plugins-offline"].map((lane) => ({
      lane,
      consumer: "plugins",
      path: pluginAssertions,
      current: "export function assertPluginUninstallConfigState() {}",
      legacy: "export function assertPluginTgzRemoved() {}",
      mode: "OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE",
    })),
  ];
  const executionSentinel = [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(`${process.env.HOME}/selected-code-executed`, "executed");',
  ].join("\n");

  it.each(aliases)(
    "rejects a missing committed $lane contract before emitting admission",
    ({ lane, path, current }) => {
      const source = `${executionSentinel}\n${current}\n`;
      const f = fixture({ [path]: source });
      const tree = f.selected.git("rev-parse", "HEAD^{tree}");
      const oid = f.selected.git("rev-parse", `${f.selected.sha}:${path}`);
      f.selected.git("config", "remote.origin.url", "fixture::unavailable");
      f.selected.git("config", "remote.origin.promisor", "true");
      f.selected.git("config", "extensions.partialClone", "origin");
      f.selected.git("config", "protocol.fixture.allow", "always");
      rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
      expect(f.selected.git("rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(readFileSync(join(f.selected.root, path), "utf8")).toBe(source);

      const result = f.run({ docker: { lanes: [lane] } });
      expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("unable to read selected source");
      expect(result.stdout).toBe("");

      const currentOnly = f.run(
        { docker: { lanes: [lane] } },
        { allowFrozenTargetScenarioOmissions: false },
      );
      expect(currentOnly.status, currentOnly.stderr).toBe(0);
      expect(JSON.parse(currentOnly.stdout).sources.selected).toEqual([]);
      expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
    },
  );

  it.each(
    aliases.flatMap((alias) =>
      (["current", "legacy"] as const).map((dialect) => Object.assign({}, alias, { dialect })),
    ),
  )("admits $lane with the committed $dialect contract", (alias) => {
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
        modes: {
          [mode]: dialect,
          ...(consumer === "plugins"
            ? { OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT: "current" }
            : {}),
        },
        files: [],
      },
    ]);
    expect(record.selectedSha).toBe(f.selected.sha);
    expect(record.toolingSha).toBe(f.tooling.sha);
    expect(existsSync(join(f.root, "selected-code-executed"))).toBe(false);
    expect(existsSync(join(f.selected.root, "node_modules"))).toBe(false);
    expect(existsSync(join(f.tooling.root, "node_modules"))).toBe(false);
  });

  it.each(aliases)(
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
          modes: {
            [mode]: consumer === "plugins" ? "current" : "legacy",
            ...(consumer === "plugins"
              ? { OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT: "current" }
              : {}),
          },
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
          OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT: "current",
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
    { lane: "live-gateway", removed: [pluginAssertions], consumer: "live-cli-backend" },
    { lane: "mcp-channels", removed: [cliMetadata], consumer: "plugins" },
    { lane: "kitchen-sink-rpc", removed: [cliMetadata], consumer: "plugins" },
    { lane: "plugins-offline", removed: [cliMetadata], consumer: "plugins" },
    { lane: "docker-package-install", removed: [cliMetadata, pluginAssertions], consumer: null },
  ])("keeps unreadable unrelated contracts inert for $lane", ({ lane, removed, consumer }) => {
    const f = fixture({
      [cliMetadata]: `${executionSentinel}\nexport function resolveCliBackendDockerPackages() {}\n`,
      [pluginAssertions]: `${executionSentinel}\nexport function assertPluginUninstallConfigState() {}\n`,
    });
    for (const path of removed) {
      const oid = f.selected.git("rev-parse", `${f.selected.sha}:${path}`);
      rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
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

  it.each(
    lanes.flatMap((lane) =>
      [
        {
          shape: "malformed version",
          version: "invalid",
          error: "selected upgrade target has an invalid release version",
        },
        {
          shape: "unsupported correction",
          version: "2026.7.33-1",
          error: "unsupported extended-stable correction",
        },
        {
          shape: "missing scenario",
          version: "2026.7.33",
          error: "selected extended-stable target lacks its scenario",
        },
        {
          shape: "missing companion blob",
          version: "2026.7.33",
          error: "unable to read selected source",
        },
      ].map((value) => Object.assign({}, value, { lane })),
    ),
  )("rejects $lane with $shape before emitting admission", ({ lane, shape, version, error }) => {
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
      f.selected.git("config", "remote.origin.url", "fixture::unavailable");
      f.selected.git("config", "remote.origin.promisor", "true");
      f.selected.git("config", "extensions.partialClone", "origin");
      f.selected.git("config", "protocol.fixture.allow", "always");
      rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
      expect(f.selected.git("rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(readFileSync(join(f.selected.root, companion), "utf8")).toBe(files[companion]);
    }
    const result = f.run({ docker: { lanes: [lane] } });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.stdout).toBe("");
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

  it.each(
    lanes.flatMap((lane) =>
      [
        { version: "2026.6.35", recipe: "config-recipe.mjs", train: "extended-stable" },
        { version: "2026.7.33", recipe: "config-recipe.mts", train: "extended-stable" },
        { version: "2026.9.9", recipe: "", train: "stable" },
      ].map((value) => Object.assign({}, value, { lane })),
    ),
  )("admits $lane with committed $version contracts", ({ lane, version, recipe, train }) => {
    const files = recipe
      ? survivorFiles(version, recipe)
      : { "package.json": JSON.stringify({ type: "module", version }) };
    const f = fixture({
      ...files,
      [pluginAssertions]: "throw new Error('unselected plugin code executed');",
    });
    const oid = f.selected.git("rev-parse", `${f.selected.sha}:${pluginAssertions}`);
    rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    const result = f.run({ docker: { lanes: [lane] } });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker).toEqual({ lanes: [lane], omitted: [], status: "ADMITTED" });
    expect(record.selection.consumers).toEqual(["upgrade-survivor"]);
    expect(record.contracts).toHaveLength(1);
    expect(record.contracts[0].modes).toEqual({
      OPENCLAW_FROZEN_UPGRADE_SURVIVOR_CLAWHUB_MODE: "current",
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

  it.each([
    "plugins-offline",
    "docker-package-install",
    "live-cli-backend-claude",
    "live-cli-backend-gemini",
    "update-first-hop-compat",
    "update-run-package-self-upgrade",
    "release-user-journey",
    "release-upgrade-user-journey",
  ])("keeps unselected upgrade contracts inert for %s", (lane) => {
    const files: Record<string, string> = {
      "package.json": '{"type":"module","version":"invalid"}',
      "src/infra/clawhub-install-trust.ts": "throw new Error('unselected upgrade code executed');",
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
      const oid = f.selected.git("rev-parse", `${f.selected.sha}:${path}`);
      rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    }
    const result = f.run({ docker: { lanes: [lane] } });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.docker).toEqual({ lanes: [lane], omitted: [], status: "ADMITTED" });
    expect(record.selection.consumers).toEqual(lane === "plugins-offline" ? ["plugins"] : []);
    expect(record.contracts.map((contract: { consumer: string }) => contract.consumer)).toEqual(
      record.selection.consumers,
    );
  });
});

describe("frozen admission bootstrap repairs", () => {
  const recipeDirectory = "scripts/e2e/lib/upgrade-survivor/config-recipe";
  const reader = "scripts/lib/frozen-target-source.mjs";
  const shell = "scripts/lib/frozen-target-compat.sh";

  it.each([reader, "scripts/lib/docker-e2e-scenarios.mts", shell])(
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
      const result = f.run({ consumers: ["onboard"] });
      expect(existsSync(sentinel), result.stderr).toBe(false);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`tooling closure does not match committed source: ${path}`);
      expect(result.stdout).toBe("");
    },
  );

  it.each([
    entrypoint,
    "scripts/lib/official-external-channel-catalog.json",
    `${recipeDirectory}/agents.json`,
    "package.json",
    "pnpm-lock.yaml",
  ])("rejects dirty closure data %s at unchanged HEAD", (path) => {
    const f = fixture();
    const file = join(f.tooling.root, path);
    writeFileSync(file, readFileSync(file, "utf8") + "\n");
    expect(f.tooling.git("rev-parse", "HEAD")).toBe(f.tooling.sha);
    const result = f.run({});
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`tooling closure does not match committed source: ${path}`);
    expect(result.stdout).toBe("");
  });

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
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("tooling closure requires an owned regular file:");
      expect(result.stdout).toBe("");
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
    const clean = f.run({ consumers: ["onboard"] }, overrides);
    expect(clean.status, clean.stderr).toBe(0);
    writeFileSync(join(f.tooling.root, "unrelated.txt"), "dirty");
    writeFileSync(join(f.selected.root, source), "unrecognized working copy");
    const dirty = f.run({ consumers: ["onboard"] }, overrides);
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
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("checkout does not match OPENCLAW_SELECTED_SHA");
    expect(result.stdout).toBe("");
  });

  it.each([entrypoint, reader, `${recipeDirectory}/agents.json`])(
    "rejects a missing committed tooling object %s without hydration",
    (path) => {
      const f = fixture();
      const oid = f.tooling.git("rev-parse", `${f.tooling.sha}:${path}`);
      f.tooling.git("config", "remote.origin.url", "fixture::unavailable");
      f.tooling.git("config", "remote.origin.promisor", "true");
      rmSync(join(f.tooling.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
      const result = f.run({});
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
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
      name: "parsed-duration legacy authorized",
      files: {
        "src/config/zod-schema.session.ts":
          "export const SessionSchema = z.object({ maintenance: z.object({ pruneAfter: z.union([z.string(), z.number()]).optional() }) });",
      },
      allow: true,
      mode: "unsupported",
    },
    {
      name: "current authorized",
      files: { "src/config/zod-schema.session-config.ts": "coldStorage: z.object({})" },
      allow: true,
      mode: "required",
    },
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
    expect(record.contracts).toEqual([
      {
        consumer: "onboard",
        status: "ADMITTED",
        modes: {
          OPENCLAW_FROZEN_TARGET_ONBOARD_CASES:
            "local-basic,remote-non-interactive,reset,channels,skills",
        },
        files: [],
      },
    ]);
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
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("unable to resolve frozen runtime-context");
    expect(invalid.stdout).toBe("");
  });

  it.each(["June", "July"])(
    "evaluates the %s shared AST owner with the real preprovisioned parser",
    (layout) => {
      const client =
        layout === "June"
          ? "scripts/e2e/agent-bundle-mcp-tools-docker-client.ts"
          : "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts";
      const prefix = layout === "June" ? "../.." : "../../../..";
      const f = fixture(
        {
          [client]: `import { getOrCreateSessionMcpRuntime, disposeAllSessionMcpRuntimes } from "${prefix}/dist/agents/agent-bundle-mcp-runtime.js";\nimport { createE2eStateDir } from "${layout === "June" ? "./lib" : `${prefix}/scripts/e2e/lib`}/temp-state-dir.ts";\nthrow new Error("target client executed");`,
          "scripts/e2e/lib/temp-state-dir.ts":
            'export async function createE2eStateDir() { throw new Error("target helper executed"); }',
          "src/agents/agent-bundle-mcp-runtime.ts":
            'export async function getOrCreateSessionMcpRuntime() { throw new Error("target runtime executed"); }\nexport async function disposeAllSessionMcpRuntimes() {}',
        },
        true,
      );
      const result = f.run({ consumers: ["agent-bundle-mcp-tools"] });
      expect(result.status, result.stderr).toBe(0);
      const record = JSON.parse(result.stdout);
      expect(record.contracts[0].modes.OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE).toBe("legacy");
      expect(record.contracts[0].files).toEqual([{ source: "selected", path: client }]);
      expect(record.sources.selected).toContainEqual({
        path: client,
        oid: f.selected.git("rev-parse", `${f.selected.sha}:${client}`),
      });
      rmSync(join(f.tooling.root, "node_modules"), { recursive: true });
      const rejected = f.run({ consumers: ["agent-bundle-mcp-tools"] });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("trusted TypeScript parser");
      expect(rejected.stdout).toBe("");
      expect(f.run({ consumers: ["onboard"] }).status).toBe(0);
    },
  );

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
        const oid = f.selected.git("rev-parse", `${f.selected.sha}:${relative}`);
        f.selected.git("config", "remote.origin.url", "fixture::unavailable");
        f.selected.git("config", "remote.origin.promisor", "true");
        f.selected.git("config", "extensions.partialClone", "origin");
        f.selected.git("config", "protocol.fixture.allow", "always");
        rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
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
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          shape === "unknown catalog" ? "inert scenario catalog" : "unable to read selected source",
        );
        expect(result.stdout).toBe("");
      }
    },
  );

  it.each([
    { scenarios: "acpx-openclaw-tools-bridge", allow: true, supported: false },
    { scenarios: "base acpx-openclaw-tools-bridge", allow: true, supported: true },
    { scenarios: "acpx-openclaw-tools-bridge", allow: false, supported: false },
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
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("require authorized scenario omissions");
        expect(result.stdout).toBe("");
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

  it("shares the Codex and fs-safe cores while preserving source read errors", () => {
    const catalog = "extensions/codex/provider-catalog.ts";
    const f = fixture({
      "package.json": '{"version":"2026.7.33","dependencies":{"@openclaw/fs-safe":"0.4.1"}}',
      [catalog]:
        'export const FALLBACK_CODEX_MODELS = [{ id: "gpt-5.5" }] satisfies unknown[];\nthrow new Error("catalog executed");',
      "src/infra/fs-safe-defaults.ts":
        'import { configureFsSafePython } from "@openclaw/fs-safe/config";',
    });
    f.selected.git("update-ref", "refs/remotes/origin/extended-stable/2026.7.33", f.selected.sha);
    const selection = {
      codexSuites: ["live-codex-harness-docker", "live-codex-harness-gpt56-sol-docker"],
      fsSafeNative: true,
    };
    const result = f.run(selection);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).contracts).toEqual([
      { consumer: "live-codex-harness-docker", status: "ADMITTED", model: "openai/gpt-5.5" },
      { consumer: "live-codex-harness-gpt56-sol-docker", status: "NOT RUN" },
      { consumer: "fs-safe-native", mode: "not-applicable" },
    ]);
    const oid = f.selected.git("rev-parse", `${f.selected.sha}:${catalog}`);
    rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    const rejected = f.run(selection);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("unable to read selected source");
    expect(rejected.stdout).toBe("");
    expect(f.run(selection, { allowFrozenTargetScenarioOmissions: false }).status).toBe(0);
  });

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
          ? { [codexManifest]: '{"name":"@openclaw/codex","version":"2026.7.33"}' }
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
      const capabilityOid = f.selected.git("rev-parse", `${f.selected.sha}:${pluginAssertions}`);
      rmSync(
        join(f.selected.root, ".git/objects", capabilityOid.slice(0, 2), capabilityOid.slice(2)),
      );
      const unreadable = f.run({ consumers: [consumer] });
      expect(unreadable.status).toBe(1);
      expect(unreadable.stderr).toContain("unable to read selected source");
      expect(unreadable.stdout).toBe("");
      expect(f.run({ consumers: ["onboard"] }).status).toBe(0);
      expect(f.selected.git("hash-object", "-w", pluginAssertions)).toBe(capabilityOid);
    }
    const oid = f.selected.git("rev-parse", `${f.selected.sha}:${files[0]}`);
    rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    const rejected = f.run({ consumers: [consumer] });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("unable to read selected source");
    expect(rejected.stdout).toBe("");
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
        const oid = f.selected.git("rev-parse", `${f.selected.sha}:${manifest}`);
        rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
      }
      for (const allow of [true, false]) {
        const result = f.run(
          { consumers: ["codex-on-demand"] },
          { allowFrozenTargetScenarioOmissions: allow },
        );
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(
          shape === "absent" ? "missing required contract file" : "unable to read selected source",
        );
        expect(result.stdout).toBe("");
      }
      expect(f.run({ consumers: ["onboard"] }).status).toBe(0);
    },
  );

  it.each(["missing run", "missing imported data", "missing companion blob", "complete"])(
    "checks the selected survivor directory closure: %s",
    (shape) => {
      const dir = "scripts/e2e/lib/upgrade-survivor";
      const files = survivorFiles();
      const companion = "scripts/e2e/lib/plugin-index-sqlite.mjs";
      if (shape === "missing run") {
        delete files[`${dir}/run.sh`];
      }
      if (shape === "missing imported data") {
        delete files[`${dir}/config-recipe/models-openai.json`];
      }
      const f = fixture(files);
      if (shape === "missing companion blob") {
        const oid = f.selected.git("rev-parse", `${f.selected.sha}:${companion}`);
        rmSync(join(f.selected.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
      }
      const result = f.run({ consumers: ["upgrade-survivor"] });
      if (shape === "complete") {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).contracts[0].modes.releaseTrain).toBe("extended-stable");
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          shape === "missing companion blob"
            ? "unable to read selected source"
            : "missing required contract file",
        );
        expect(result.stdout).toBe("");
      }
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
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
