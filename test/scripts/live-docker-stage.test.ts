// Live Docker Stage tests cover live docker stage script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFrozenTargetSource } from "../../scripts/lib/frozen-target-source.mjs";
import { addStagedPrivatePluginSdkExports } from "../../scripts/live-docker-stage-private-sdk-exports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageScriptPath = path.join(repoRoot, "scripts/lib/live-docker-stage.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function committedSourceFixture(files: Record<string, string | null>) {
  const root = tempDirs.make("openclaw-frozen-source-");
  for (const [relative, content] of Object.entries(files)) {
    if (content === null) {
      continue;
    }
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { root, git, commit, sha: commit() };
}

describe("frozen committed source errors", () => {
  const metadata = "scripts/print-cli-backend-live-metadata.ts";
  const gatewayOld = "scripts/e2e/lib/gateway-network/client.mjs";
  const gatewayNew = "scripts/e2e/lib/gateway-network/client.mts";

  function invoke(
    source: { root: string; sha: string },
    command: string,
    env: Record<string, string> = {},
  ) {
    return spawnSync(
      "bash",
      ["-c", `set -euo pipefail; source "$1"; ${command}`, "test", stageScriptPath, source.root],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: source.sha,
          OPENCLAW_TOOLING_SHA: "b".repeat(40),
          ...env,
        },
      },
    );
  }

  function removeObject(source: ReturnType<typeof committedSourceFixture>, expression: string) {
    const oid = source.git("rev-parse", expression);
    const objectPath = path.join(source.root, ".git/objects", oid.slice(0, 2), oid.slice(2));
    rmSync(objectPath);
    return objectPath;
  }

  it("reads committed text through the imported API and distinguishes absent from unreadable blobs", () => {
    const committedText = "selected committed text\n";
    const source = committedSourceFixture({ [metadata]: committedText });
    writeFileSync(path.join(source.root, metadata), "dirty worktree decoy\n");
    const reader = createFrozenTargetSource(source.root, source.sha);
    expect(reader.readText(metadata)).toBe(committedText);
    expect(reader.readText("scripts/absent.ts")).toBeNull();

    removeObject(source, `${source.sha}:${metadata}`);
    const freshReader = createFrozenTargetSource(source.root, source.sha);
    expect(() => freshReader.readText(metadata)).toThrow();
  });

  it("distinguishes genuine absence from read errors through fallback and negative predicates", () => {
    const source = committedSourceFixture({ "package.json": "{}\n" });
    const result = invoke(
      source,
      `openclaw_resolve_frozen_target_file "$2" ${metadata} fallback; openclaw_resolve_frozen_live_cli_backend_package_mode "$2"; printf '%s\\n' "$OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE"`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("fallback\nlegacy\n");
  });

  it.each(["commit", "root tree", "intermediate tree", "blob"] as const)(
    "propagates a missing %s without hydrating a promisor or returning fallback",
    (kind) => {
      const source = committedSourceFixture({ [metadata]: "resolveCliBackendDockerPackages\n" });
      const expression =
        kind === "commit"
          ? source.sha
          : kind === "root tree"
            ? `${source.sha}^{tree}`
            : kind === "intermediate tree"
              ? `${source.sha}:scripts`
              : `${source.sha}:${metadata}`;
      const bin = path.join(source.root, "bin");
      const transportLog = path.join(source.root, "transport.log");
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, "git-remote-fixture"),
        '#!/bin/sh\nprintf "unexpected hydration\\n" >> "$SOURCE_TRANSPORT_LOG"\nexit 97\n',
        { mode: 0o755 },
      );
      source.git("config", "remote.origin.url", "fixture::unavailable");
      source.git("config", "remote.origin.promisor", "true");
      source.git("config", "extensions.partialClone", "origin");
      source.git("config", "protocol.fixture.allow", "always");
      removeObject(source, expression);
      const env = { PATH: `${bin}:${process.env.PATH}`, SOURCE_TRANSPORT_LOG: transportLog };
      for (const command of [
        'openclaw_prepare_frozen_target_context "$2"',
        `openclaw_resolve_frozen_target_file "$2" ${metadata} fallback`,
        'openclaw_resolve_frozen_live_cli_backend_package_mode "$2"',
      ]) {
        if (command.includes("prepare") && (kind === "intermediate tree" || kind === "blob")) {
          continue;
        }
        const result = invoke(source, `status=0; ${command} || status=$?; exit "$status"`, env);
        expect(result.status, `${command}\n${result.stderr}`).toBe(2);
        expect(result.stdout).toBe("");
      }
      expect(existsSync(transportLog)).toBe(false);
    },
  );

  it.each(["positive", "negative"] as const)(
    "rejects a corrupt blob in a %s marker predicate even under a conditional caller",
    (kind) => {
      const marker = kind === "positive" ? "src/cli/update-cli/update-command.ts" : metadata;
      const source = committedSourceFixture({ [marker]: "contract marker\n" });
      const objectPath = removeObject(source, `${source.sha}:${marker}`);
      writeFileSync(objectPath, "corrupt fixture object\n");
      const resolver =
        kind === "positive"
          ? "openclaw_resolve_frozen_update_channel_dry_run_mode"
          : "openclaw_resolve_frozen_live_cli_backend_package_mode";
      const result = invoke(source, `status=0; ${resolver} "$2" || status=$?; exit "$status"`);
      expect(result.status, result.stderr).toBe(2);
    },
  );

  it.each([
    ["upgrade_survivor_capabilities", "src/infra/clawhub-install-trust.ts"],
    ["upgrade_survivor_capabilities", "src/plugins/clawhub.ts"],
    ["plugin_harness_capabilities", "scripts/e2e/lib/plugins/assertions.mjs"],
    ["plugin_harness_capabilities", "src/config/types.messages.ts"],
    ["plugin_harness_capabilities", "src/config/types.plugins.ts"],
    ["plugin_harness_capabilities", "src/plugin-sdk/session-store-runtime.ts"],
    ["plugin_harness_capabilities", "src/plugins/uninstall-package-plan.ts"],
    ["core_harness_capabilities", "src/config/zod-schema.ts"],
    ["core_harness_capabilities", "src/commands/onboard-hooks.ts"],
    ["core_harness_capabilities", "src/agents/memory-search.ts"],
    ["core_harness_capabilities", "src/state/openclaw-agent-db-session-migrations.ts"],
    ["core_harness_capabilities", "src/commands/doctor-session-transcripts.ts"],
    ["core_harness_capabilities", "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts"],
    ["core_harness_capabilities", "src/agents/code-mode-namespaces.ts"],
  ])("propagates %s read failure at %s", (resolver, relative) => {
    const source = committedSourceFixture({
      "src/plugins/clawhub.ts": 'from "../infra/clawhub.js"',
      "scripts/e2e/lib/plugins/assertions.mjs": "function assertPluginTgzRemoved() {}",
      "src/config/types.messages.ts": "tts?: TtsConfig;",
      "src/config/types.plugins.ts": 'bundledDiscovery?: "compat" | "allowlist";',
      "src/plugin-sdk/session-store-runtime.ts": "before SQLite migration",
      "src/config/zod-schema.ts": "lastRunAt:",
      "src/commands/onboard-hooks.ts": "setupInternalHooks",
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts":
        "fragments?: RuntimeContextFragment[];\nconst fragments = params.fragments?.filter",
      [relative]: "unavailable source bytes",
    });
    removeObject(source, `${source.sha}:${relative}`);
    const result = invoke(
      source,
      `status=0; openclaw_resolve_frozen_${resolver} "$2" || status=$?; exit "$status"`,
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("unable to read selected source");
  });

  it("ignores replacement objects and ambient Git repository routing", () => {
    const source = committedSourceFixture({ [metadata]: "resolveCliBackendDockerPackages\n" });
    const original = source.git("rev-parse", `${source.sha}:${metadata}`);
    const replacementPath = path.join(source.root, "replacement");
    writeFileSync(replacementPath, "legacy decoy\n");
    const replacement = source.git("hash-object", "-w", replacementPath);
    source.git("replace", original, replacement);
    const decoy = committedSourceFixture({ "package.json": "{}\n" });
    const result = invoke(
      source,
      'openclaw_resolve_frozen_live_cli_backend_package_mode "$2"; printf "%s\\n" "$OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE"',
      {
        GIT_DIR: path.join(decoy.root, ".git"),
        GIT_WORK_TREE: decoy.root,
        GIT_OBJECT_DIRECTORY: path.join(decoy.root, ".git/objects"),
        GIT_NO_REPLACE_OBJECTS: "0",
        GIT_NO_LAZY_FETCH: "0",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("current\n");
  });

  it.each(["oversized", "invalid UTF-8", "wrong object bytes"] as const)(
    "rejects %s instead of classifying text",
    (kind) => {
      const source = committedSourceFixture({ [metadata]: "original\n" });
      const original = source.git("rev-parse", `${source.sha}:${metadata}`);
      writeFileSync(
        path.join(source.root, metadata),
        kind === "oversized"
          ? "x".repeat(16 * 1024 * 1024 + 1)
          : kind === "invalid UTF-8"
            ? Buffer.from([0xff])
            : "different\n",
      );
      source.sha = source.commit();
      if (kind === "wrong object bytes") {
        const current = source.git("rev-parse", `${source.sha}:${metadata}`);
        const objectDir = path.join(source.root, ".git/objects");
        const content = readFileSync(path.join(objectDir, original.slice(0, 2), original.slice(2)));
        const currentPath = path.join(objectDir, current.slice(0, 2), current.slice(2));
        rmSync(currentPath);
        writeFileSync(currentPath, content);
      }
      const result = invoke(
        source,
        'status=0; openclaw_resolve_frozen_live_cli_backend_package_mode "$2" || status=$?; exit "$status"',
      );
      expect(result.status, result.stderr).toBe(2);
    },
  );

  it("matches literal committed paths and treats an empty blob as present", () => {
    const relative = "scripts/[literal]*.ts";
    const source = committedSourceFixture({ [relative]: "", [metadata]: "match\n" });
    writeFileSync(path.join(source.root, metadata), "dirty decoy\n");
    const result = invoke(
      source,
      `openclaw_frozen_target_source_has_path "$2" '${relative}'; openclaw_frozen_target_source_contains "$2" ${metadata} match`,
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["symlink", "directory", "gitlink"] as const)(
    "rejects a %s substitution for a selected file",
    (kind) => {
      const source = committedSourceFixture({ [metadata]: "marker\n" });
      rmSync(path.join(source.root, metadata));
      if (kind === "symlink") {
        symlinkSync("missing", path.join(source.root, metadata));
        source.sha = source.commit();
      } else if (kind === "directory") {
        mkdirSync(path.join(source.root, metadata));
        writeFileSync(path.join(source.root, metadata, "nested"), "marker\n");
        source.sha = source.commit();
      } else {
        source.git("update-index", "--cacheinfo", `160000,${source.sha},${metadata}`);
        source.git("commit", "-qm", "gitlink fixture");
        source.sha = source.git("rev-parse", "HEAD");
      }
      const result = invoke(
        source,
        `status=0; openclaw_resolve_frozen_target_file "$2" ${metadata} fallback || status=$?; exit "$status"`,
      );
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
    },
  );

  it("allows only the explicitly directory-owned upgrade scenario tree", () => {
    const directory = "scripts/e2e/lib/upgrade-survivor";
    const source = committedSourceFixture({ [`${directory}/run.sh`]: "#!/bin/sh\n" });
    const result = invoke(source, `openclaw_resolve_frozen_target_file "$2" ${directory}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${source.root}/${directory}\n`);
    removeObject(source, `${source.sha}:${directory}`);
    const missing = invoke(source, `openclaw_resolve_frozen_target_file "$2" ${directory}`);
    expect(missing.status, missing.stderr).toBe(2);
    expect(missing.stdout).toBe("");
  });

  it.each(["../package.json", "/package.json", "scripts//entry", "scripts/./entry"])(
    "rejects unsafe path %s instead of treating it as absent",
    (relative) => {
      const source = committedSourceFixture({ "package.json": "{}\n" });
      const result = invoke(
        source,
        `status=0; openclaw_frozen_target_source_has_path "$2" "${relative}" || status=$?; exit "$status"`,
      );
      expect(result.status, result.stderr).toBe(2);
    },
  );

  it("stops the gateway wrapper before Docker when the negative layout read fails", () => {
    const source = committedSourceFixture({ [gatewayOld]: "old\n", [gatewayNew]: "current\n" });
    removeObject(source, `${source.sha}:${gatewayNew}`);
    const bin = path.join(source.root, "bin");
    const log = path.join(source.root, "docker.log");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "docker"),
      '#!/bin/sh\nprintf "called\\n" >> "$DOCKER_LOG"\nexit 91\n',
      {
        mode: 0o755,
      },
    );
    const result = invoke(source, "bash scripts/e2e/gateway-network-docker.sh", {
      PATH: `${bin}:${process.env.PATH}`,
      DOCKER_LOG: log,
      OPENCLAW_DOCKER_E2E_REPO_ROOT: source.root,
      OPENCLAW_GATEWAY_NETWORK_E2E_SKIP_BUILD: "1",
    });
    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(log)).toBe(false);
  });

  it.each([
    { old: true, current: false, authorization: "1", legacy: true },
    { old: true, current: true, authorization: "1", legacy: false },
    { old: false, current: true, authorization: "1", legacy: false },
    { old: true, current: false, authorization: "0", legacy: false },
  ])("preserves gateway layout selection $old/$current/$authorization", (entry) => {
    const source = committedSourceFixture({
      [gatewayOld]: entry.old ? "old\n" : null,
      [gatewayNew]: entry.current ? "current\n" : null,
    });
    const result = invoke(
      source,
      'openclaw_resolve_frozen_gateway_network_layout "$2"; printf "%s\\n" "$OPENCLAW_FROZEN_TARGET_GATEWAY_NETWORK_LEGACY_LIB"',
      { OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: entry.authorization },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(entry.legacy ? `${source.root}/scripts/e2e/lib\n` : "\n");
  });
});

describe("frozen bundle committed contract", () => {
  const juneClient = "scripts/e2e/agent-bundle-mcp-tools-docker-client.ts";
  const julyClient = "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts";
  const helperPath = "scripts/e2e/lib/temp-state-dir.ts";
  const runtimePath = "src/agents/agent-bundle-mcp-runtime.ts";
  const managerPath = "src/agents/agent-bundle-mcp-manager-api.ts";
  const runtimeSource =
    "export async function getOrCreateSessionMcpRuntime() {}\nexport async function disposeAllSessionMcpRuntimes() {}\n";
  const managerSource =
    "export async function acquireSessionMcpRuntime() {}\nexport async function disposeAllSessionMcpRuntimes() {}\n";

  function fixture(
    layout: "June" | "July" | "current" = "July",
    overrides: Record<string, string | null> = {},
  ) {
    const clientPath = layout === "June" ? juneClient : julyClient;
    const prefix = layout === "June" ? "../.." : "../../../..";
    const owner = layout === "current" ? "manager-api" : "runtime";
    const acquire =
      layout === "current" ? "acquireSessionMcpRuntime" : "getOrCreateSessionMcpRuntime";
    const files: Record<string, string | null> = {
      "package.json": '{"type":"module","version":"2026.1.0"}\n',
      [clientPath]: [
        `import { ${acquire}, disposeAllSessionMcpRuntimes } from "${prefix}/dist/agents/agent-bundle-mcp-${owner}.js";`,
        `import { createE2eStateDir } from "${layout === "June" ? "./lib" : `${prefix}/scripts/e2e/lib`}/temp-state-dir.ts";`,
        'throw new Error("selected client must not execute during resolution");',
        "",
      ].join("\n"),
      [helperPath]: "export async function createE2eStateDir() {}\n",
      [runtimePath]: runtimeSource,
      ...(layout === "current" ? { [managerPath]: managerSource } : {}),
      ...overrides,
    };
    return { ...committedSourceFixture(files), clientPath, files };
  }

  function resolve(
    source: { root: string; sha: string },
    env: Record<string, string> = {},
    cwd = repoRoot,
  ) {
    return spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; status=0; openclaw_resolve_frozen_agent_bundle_mcp_contract "$2" || status=$?; printf "%s:%s\\n" "$OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE" "$OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_CLIENT_PATH"; exit "$status"',
        "test",
        stageScriptPath,
        source.root,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: source.sha,
          OPENCLAW_TOOLING_SHA: "b".repeat(40),
          OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE: "stale",
          OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_CLIENT_PATH: "stale",
          ...env,
        },
      },
    );
  }

  function expectRejected(result: ReturnType<typeof resolve>, message: string) {
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe(":\n");
  }

  it.each(["June", "July", "current"] as const)(
    "selects the committed %s contract regardless of package version and dirty decoys",
    (layout) => {
      const source = fixture(layout);
      writeFileSync(path.join(source.root, source.clientPath), "dirty client\n");
      writeFileSync(path.join(source.root, helperPath), "dirty helper\n");
      writeFileSync(path.join(source.root, "package.json"), '{"type":"commonjs"}');
      if (layout !== "current") {
        writeFileSync(path.join(source.root, managerPath), managerSource);
      }
      const result = resolve(source);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `${layout === "current" ? "current" : "legacy"}:${source.clientPath}\n`,
      );
    },
  );

  it("keeps authorization off on the current harness without reading selected source", () => {
    const result = resolve(
      { root: "/nonexistent-bundle-source", sha: "malformed" },
      { OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`current:${julyClient}\n`);
  });

  it("loads the parser from trusted tooling even when invoked inside selected source", () => {
    const source = fixture();
    const targetParser = path.join(source.root, "node_modules/typescript");
    mkdirSync(targetParser, { recursive: true });
    writeFileSync(path.join(targetParser, "package.json"), '{"main":"index.js"}');
    writeFileSync(
      path.join(targetParser, "index.js"),
      'throw new Error("target parser executed");',
    );
    const result = resolve(source, {}, source.root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`legacy:${julyClient}\n`);
  });

  it.each<{ env: Record<string, string>; error: string }>([
    { env: { OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "yes" }, error: "expected 0 or 1" },
    { env: { OPENCLAW_SELECTED_SHA: "short" }, error: "full lowercase commit SHA" },
    { env: { OPENCLAW_TOOLING_SHA: "SHORT" }, error: "full lowercase commit SHA" },
    { env: { OPENCLAW_SELECTED_SHA: "c".repeat(40) }, error: "checkout does not match" },
  ])("rejects malformed frozen identity $env", ({ env, error }) => {
    expectRejected(resolve(fixture(), env), error);
  });

  it("rejects identical selected and tooling identities", () => {
    const source = fixture();
    expectRejected(resolve(source, { OPENCLAW_TOOLING_SHA: source.sha }), "require distinct");
  });

  it.each<{ name: string; files: Record<string, string | null>; error: string }>([
    { name: "both layouts", files: { [juneClient]: "export {};\n" }, error: "exactly one" },
    { name: "no layout", files: { [julyClient]: null }, error: "exactly one" },
    { name: "missing runtime", files: { [runtimePath]: null }, error: "missing required" },
    {
      name: "unknown runtime",
      files: { [runtimePath]: "export {};\n" },
      error: "client/API contract",
    },
    {
      name: "unknown manager",
      files: { [managerPath]: "export {};\n" },
      error: "client/API contract",
    },
    {
      name: "mixed manager/client",
      files: { [managerPath]: managerSource },
      error: "client/API contract",
    },
    { name: "unknown client", files: { [julyClient]: "export {};\n" }, error: "helper contract" },
    { name: "missing helper", files: { [helperPath]: null }, error: "missing required" },
    { name: "unknown helper", files: { [helperPath]: "export {};\n" }, error: "helper contract" },
    { name: "missing manifest", files: { "package.json": null }, error: "package.json" },
    { name: "invalid manifest", files: { "package.json": "invalid" }, error: "package.json" },
    {
      name: "non-ESM manifest",
      files: { "package.json": '{"type":"commonjs"}' },
      error: "ESM scope",
    },
  ])("rejects $name without publishing stale selection", ({ files, error }) => {
    expectRejected(resolve(fixture("July", files)), error);
  });

  it("rejects a manager client whose required API export is missing", () => {
    expectRejected(
      resolve(
        fixture("current", {
          [managerPath]: "export async function acquireSessionMcpRuntime() {}\n",
        }),
      ),
      "client/API contract",
    );
  });

  it.each(
    [runtimePath, helperPath, julyClient].flatMap((relative) =>
      ["comment", "template", "invalid syntax"].map((form) => ({ relative, form })),
    ),
  )("rejects $relative contract markers in $form", ({ relative, form }) => {
    const source = fixture();
    const original = source.files[relative];
    const content =
      form === "comment"
        ? `/*\n${original}*/\n`
        : form === "template"
          ? `const inert = \`\n${original}\`;\n`
          : `${original}\nfunction (`;
    writeFileSync(path.join(source.root, relative), content);
    source.sha = source.commit();
    expectRejected(resolve(source), "contract");
  });

  it.each([julyClient, helperPath, "package.json", runtimePath, managerPath, "test/e2e"])(
    "rejects committed symlinks at %s",
    (relative) => {
      const source = fixture();
      rmSync(path.join(source.root, relative), { recursive: true, force: true });
      symlinkSync("nonexistent-target", path.join(source.root, relative));
      source.sha = source.commit();
      const result = resolve(source);
      expectRejected(result, relative === "package.json" ? "package.json" : "expected");
    },
  );

  it("rejects a directory in place of a client blob", () => {
    const source = fixture();
    rmSync(path.join(source.root, julyClient));
    mkdirSync(path.join(source.root, julyClient));
    writeFileSync(path.join(source.root, julyClient, "nested.ts"), "export {};\n");
    source.sha = source.commit();
    expectRejected(resolve(source), "expected regular committed file");
  });

  it.each([
    "commit",
    "root tree",
    "intermediate tree",
    "client blob",
    "manager blob",
    "helper blob",
  ])("rejects a missing %s without lazy hydration", (missing) => {
    const source = fixture("current");
    const object = source.git(
      "rev-parse",
      missing === "commit"
        ? source.sha
        : missing === "root tree"
          ? `${source.sha}^{tree}`
          : `${source.sha}:${
              missing === "intermediate tree"
                ? "src/agents"
                : missing === "client blob"
                  ? julyClient
                  : missing === "manager blob"
                    ? managerPath
                    : helperPath
            }`,
    );
    const bin = path.join(source.root, "transport-bin");
    const transportLog = path.join(source.root, "transport.log");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "git-remote-fixture"),
      '#!/bin/sh\nprintf "unexpected hydration\\n" >> "$BUNDLE_TRANSPORT_LOG"\nexit 1\n',
      { mode: 0o755 },
    );
    source.git("config", "remote.origin.url", "fixture::unavailable");
    source.git("config", "remote.origin.promisor", "true");
    source.git("config", "extensions.partialClone", "origin");
    source.git("config", "protocol.fixture.allow", "always");
    rmSync(path.join(source.root, ".git/objects", object.slice(0, 2), object.slice(2)));
    const result = resolve(source, {
      PATH: `${bin}:${process.env.PATH}`,
      BUNDLE_TRANSPORT_LOG: transportLog,
    });
    expectRejected(result, "unable to read selected bundle source");
    expect(existsSync(transportLog)).toBe(false);
  });

  it("rejects a corrupt referenced blob instead of treating its owner as absent", () => {
    const source = fixture("current");
    const object = source.git("rev-parse", `${source.sha}:${managerPath}`);
    const objectPath = path.join(source.root, ".git/objects", object.slice(0, 2), object.slice(2));
    rmSync(objectPath);
    writeFileSync(objectPath, "corrupt fixture object\n");
    expectRejected(resolve(source), "unable to read selected bundle source");
  });

  it("does not read an unrelated missing runtime-context blob", () => {
    const unrelated = "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts";
    const source = fixture("July", { [unrelated]: "unknown runtime-context contract\n" });
    const object = source.git("rev-parse", `${source.sha}:${unrelated}`);
    rmSync(path.join(source.root, ".git/objects", object.slice(0, 2), object.slice(2)));
    const result = resolve(source);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`legacy:${julyClient}\n`);
  });

  it("rejects older Git before attempting object reads", () => {
    const source = fixture();
    const bin = path.join(source.root, "old-git-bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "git"),
      '#!/bin/sh\ncase "$*" in *--version) printf "git version 2.44.0\\n";; *) exit 99;; esac\n',
      { mode: 0o755 },
    );
    expectRejected(resolve(source, { PATH: `${bin}:${process.env.PATH}` }), "Git 2.45 or newer");
  });
});

describe("live Docker state staging", () => {
  function linkFixtureNodeModules(root: string) {
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"));
  }

  function writeFixturePackageSpecParser(root: string) {
    const parserPath = path.join(root, "src", "infra", "npm-registry-spec.ts");
    mkdirSync(path.dirname(parserPath), { recursive: true });
    writeFileSync(
      parserPath,
      String.raw`
export function parseRegistryNpmSpec(spec: string) {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9][a-z0-9._-]*)?$/u.test(spec)
    ? { raw: spec }
    : null;
}
`,
    );
  }

  it.each([
    { geminiKey: "test-gemini-key", googleKey: "", expectedType: "gemini-api-key" },
    { geminiKey: "", googleKey: "test-google-key", expectedType: "vertex-ai" },
    { geminiKey: "", googleKey: "", expectedType: "oauth-personal" },
  ])("selects $expectedType from the supplied Gemini credentials", (testCase) => {
    const home = tempDirs.make("openclaw-live-stage-gemini-");
    const settingsPath = path.join(home, ".gemini", "settings.json");
    mkdirSync(path.dirname(settingsPath));
    writeFileSync(
      settingsPath,
      JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
        privacy: { usageStatisticsEnabled: false },
      }),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; openclaw_live_stage_gemini_auth', "bash", stageScriptPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          GEMINI_API_KEY: testCase.geminiKey,
          GOOGLE_API_KEY: testCase.googleKey,
          GOOGLE_GENAI_USE_VERTEXAI: "",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.security.auth.selectedType).toBe(testCase.expectedType);
    expect(settings.security.auth.enforcedType).toBe(
      testCase.geminiKey || testCase.googleKey ? testCase.expectedType : undefined,
    );
    expect(settings.privacy).toEqual({ usageStatisticsEnabled: false });
    expect(readFileSync(settingsPath, "utf8")).not.toContain("test-gemini-key");
    expect(readFileSync(settingsPath, "utf8")).not.toContain("test-google-key");
  });

  it("installs missing CLI executables and refreshes pinned packages", () => {
    const root = tempDirs.make("openclaw-live-stage-cli-");
    const binDir = path.join(root, "bin");
    mkdirSync(binDir);
    const npmPath = path.join(binDir, "npm");
    const timeoutPath = path.join(binDir, "timeout");
    writeFileSync(
      npmPath,
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$3" >> "$INSTALL_LOG"\nprintf "#!/usr/bin/env bash\\nprintf fixture-ok" > "$CLI_PATH"\nchmod +x "$CLI_PATH"\n',
    );
    chmodSync(npmPath, 0o755);
    writeFileSync(
      timeoutPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
    );
    chmodSync(timeoutPath, 0o755);
    const installLog = path.join(root, "installs.log");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; "$CLI_PATH"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend@1.0.0 10',
        "test",
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CLI_PATH: path.join(binDir, "fixture"),
          INSTALL_LOG: installLog,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("fixture-ok");
    expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual([
      "@fixture/backend",
      "@fixture/backend@1.0.0",
    ]);
  });

  it("fails explicitly when a selected backend has no executable or install package", () => {
    const root = tempDirs.make("openclaw-live-stage-cli-missing-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$2" "" 10',
        "test",
        stageScriptPath,
        path.join(root, "missing-cli"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("CLI backend executable was not provisioned:");
  });

  it.each([
    {
      entrypoint: "scripts/test-live.mts",
      expected: "--import tsx scripts/test-live.mts -- target",
    },
    { entrypoint: "scripts/test-live.mjs", expected: "scripts/test-live.mjs -- target" },
  ])("runs the staged $entrypoint live runner", ({ entrypoint, expected }) => {
    const root = tempDirs.make("openclaw-live-stage-entrypoint-");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "calls");
    mkdirSync(path.join(root, path.dirname(entrypoint)), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(root, entrypoint), "");
    writeFileSync(
      path.join(binDir, "node"),
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$*" > "$CALLS_PATH"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_run_staged_script scripts/test-live -- target',
        "test",
        root,
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CALLS_PATH: callsPath },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, "utf8").trim()).toBe(expected);
  });

  it("refuses to replace a missing staged live runner", () => {
    const root = tempDirs.make("openclaw-live-stage-entrypoint-missing-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set +e; cd "$1"; source "$2"; openclaw_live_run_staged_script scripts/test-live -- target',
        "test",
        root,
        stageScriptPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("staged OpenClaw script entrypoint not found");
  });

  it("installs validated Docker packages from the staged metadata export", () => {
    const root = tempDirs.make("openclaw-live-stage-packages-");
    const binDir = path.join(root, "bin");
    const installLog = path.join(root, "installs.log");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(binDir);
    linkFixtureNodeModules(root);
    writeFixturePackageSpecParser(root);
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      'export async function resolveCliBackendDockerPackages() { return ["@fixture/cli@1.2.3", "fixture-cli"]; }\n',
    );
    writeFileSync(
      path.join(binDir, "timeout"),
      '#!/usr/bin/env bash\nset -euo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(binDir, "npm"),
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_prepare_cli_backend_docker_packages "fixture-provider" "fixture-provider/model"',
        "test",
        root,
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_LOG: installLog,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual([
      "install -g @fixture/cli@1.2.3",
      "install -g fixture-cli",
    ]);
  });

  it("allows historical package setup omission only through its derived capability", () => {
    const root = tempDirs.make("openclaw-live-stage-packages-missing-");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    linkFixtureNodeModules(root);
    writeFixturePackageSpecParser(root);
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      "export const legacyMetadata = true;\n",
    );
    const command = [
      "-c",
      'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_prepare_cli_backend_docker_packages "" ""',
      "test",
      root,
      stageScriptPath,
    ];
    const rawControl = spawnSync("bash", command, {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1" },
    });
    expect(rawControl.status).not.toBe(0);
    expect(rawControl.stderr).toContain("does not export resolveCliBackendDockerPackages");

    const derivedCapability = spawnSync("bash", command, {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE: "legacy",
      },
    });
    expect(derivedCapability.status, derivedCapability.stderr).toBe(0);
    expect(derivedCapability.stdout).toContain("preserving historical no-package-setup behavior");
  });

  it("lets staged metadata output flush through normal Node completion", () => {
    const source = readFileSync(stageScriptPath, "utf8");
    const moduleStart = source.indexOf("node --import tsx --input-type=module <<'NODE'");
    const moduleEnd = source.indexOf("\nNODE\n", moduleStart);
    expect(moduleStart).toBeGreaterThanOrEqual(0);
    expect(moduleEnd).toBeGreaterThan(moduleStart);
    const moduleSource = source.slice(moduleStart, moduleEnd);
    expect(moduleSource).not.toContain("process.exit(");
    expect(moduleSource.match(/process\.stdout\.write/gu)).toHaveLength(1);
  });

  it("rejects malformed staged package metadata before npm runs", () => {
    const root = tempDirs.make("openclaw-live-stage-packages-malformed-");
    const binDir = path.join(root, "bin");
    const installLog = path.join(root, "installs.log");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(binDir);
    linkFixtureNodeModules(root);
    writeFixturePackageSpecParser(root);
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      'export async function resolveCliBackendDockerPackages() { return ["--force"]; }\n',
    );
    writeFileSync(
      path.join(binDir, "npm"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_prepare_cli_backend_docker_packages "" ""',
        "test",
        root,
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_LOG: installLog,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid Docker CLI package");
    expect(() => readFileSync(installLog, "utf8")).toThrow();
  });

  it("defaults frozen-target omissions closed and rejects invalid identity", () => {
    const command = [
      "-c",
      'set -euo pipefail; source "$1"; openclaw_frozen_target_omissions_authorized',
      "test",
      stageScriptPath,
    ];
    const run = (env: Record<string, string>) =>
      spawnSync("bash", command, { encoding: "utf8", env: { ...process.env, ...env } });

    expect(run({}).status).toBe(1);
    const sameSha = run({
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
      OPENCLAW_SELECTED_SHA: "a".repeat(40),
      OPENCLAW_TOOLING_SHA: "a".repeat(40),
    });
    expect(sameSha.status).toBe(2);
    expect(sameSha.stderr).toContain("require distinct selected and tooling SHAs");

    const malformed = run({
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "yes",
      OPENCLAW_SELECTED_SHA: "a".repeat(40),
      OPENCLAW_TOOLING_SHA: "b".repeat(40),
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS");
  });

  it("falls back without frozen context but fails malformed authorization", () => {
    const command = [
      "-c",
      'set -euo pipefail; source "$1"; openclaw_resolve_frozen_target_file "$2" missing/path fallback',
      "test",
      stageScriptPath,
      repoRoot,
    ];
    const run = (env: Record<string, string>) =>
      spawnSync("bash", command, { encoding: "utf8", env: { ...process.env, ...env } });

    const absent = run({});
    expect(absent.status).toBe(0);
    expect(absent.stdout).toBe("fallback\n");

    const malformed = run({ OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "yes" });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS");
  });

  it("can omit a contract file absent from an authorized frozen target", () => {
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_resolve_frozen_target_file "$2" missing/path current-path ""',
        "test",
        stageScriptPath,
        repoRoot,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: selectedSha,
          OPENCLAW_TOOLING_SHA: "b".repeat(40),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("\n");
  });

  it("keeps a matching frozen-source capability under pipefail", () => {
    const root = tempDirs.make("openclaw-frozen-target-capability-");
    const sourcePath = path.join(root, "scripts/e2e/lib/plugins/assertions.mjs");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, `function assertPluginTgzRemoved()\n${"x\n".repeat(100_000)}`);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_frozen_target_source_contains "$2" scripts/e2e/lib/plugins/assertions.mjs "function assertPluginTgzRemoved()"',
        "test",
        stageScriptPath,
        root,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_SELECTED_SHA: selectedSha,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("derives stored-dev preview compatibility from the selected source", () => {
    const root = tempDirs.make("openclaw-frozen-update-channel-");
    const sourcePath = path.join(root, "src/cli/update-cli/update-command.ts");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      'const switchToGit = requestedChannel === "dev" && installKind !== "git";\n',
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "legacy"], { cwd: root });
    const legacySha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    writeFileSync(
      sourcePath,
      'const switchToGit = installKind !== "git" &&\n  (requestedChannel === "dev" || (selectedChannel === "dev" && explicitTag === null));\n',
    );
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "current"], { cwd: root });
    const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const run = (selectedSha: string, authorized = true) => {
      execFileSync("git", ["checkout", "-q", selectedSha], { cwd: root });
      return spawnSync(
        "bash",
        [
          "-c",
          'set -euo pipefail; source "$1"; openclaw_resolve_frozen_update_channel_dry_run_mode "$2"; printf "%s:%s\\n" "$OPENCLAW_UPDATE_CHANNEL_DRY_RUN_PACKAGE_COMPAT" "$OPENCLAW_UPDATE_CHANNEL_DIRTY_BLOCK_EXIT_ZERO_COMPAT"',
          "test",
          stageScriptPath,
          root,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: authorized ? "1" : "0",
            OPENCLAW_SELECTED_SHA: selectedSha,
            OPENCLAW_TOOLING_SHA: "f".repeat(40),
          },
        },
      );
    };

    expect(run(legacySha).stdout).toBe("1:1\n");
    expect(run(currentSha).stdout).toBe("0:0\n");
    expect(run(legacySha, false).stdout).toBe("0:0\n");
  });

  it("derives frozen harness capabilities only from an authorized selected source", () => {
    const root = tempDirs.make("openclaw-frozen-target-core-dialects-");
    mkdirSync(path.join(root, "src/agents"), { recursive: true });
    mkdirSync(path.join(root, "src/agents/embedded-agent-runner/run"), { recursive: true });
    mkdirSync(path.join(root, "src/commands"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(root, "src/config"), { recursive: true });
    writeFileSync(
      path.join(root, "src/agents/code-mode-namespaces.ts"),
      'export const globals = ["ALL_TOOLS"];\n',
    );
    writeFileSync(
      path.join(root, "src/config/zod-schema.ts"),
      "const wizard = { lastRunAt: true };\n",
    );
    writeFileSync(
      path.join(root, "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts"),
      "import { extractInternalRuntimeContext } from '../../internal-runtime-context.js';\ntype Params = {\n  modelPrompt?: string;\n};\n",
    );
    writeFileSync(
      path.join(root, "src/commands/doctor-session-transcripts.ts"),
      'const backup = ".pre-doctor-branch-repair-";\n',
    );
    writeFileSync(
      path.join(root, "scripts", "print-cli-backend-live-metadata.ts"),
      "export const legacyMetadata = true;\n",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const resolveCoreDialects = [
      "-c",
      'set -euo pipefail; source "$1"; openclaw_resolve_frozen_core_harness_capabilities "$2"; openclaw_resolve_frozen_live_cli_backend_package_mode "$2"; printf "%s|%s|%s|%s|%s\\n" "$OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE" "$OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE" "$OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE" "$OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE" "$OPENCLAW_FROZEN_TARGET_ONBOARD_CASES"',
      "test",
      stageScriptPath,
      root,
    ] as const;

    const strictResult = spawnSync("bash", resolveCoreDialects, {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0",
      },
    });

    expect(strictResult.status, strictResult.stderr).toBe(0);
    expect(strictResult.stdout.trim()).toBe("sqlite|current|current|producer-fragments|");

    const result = spawnSync("bash", resolveCoreDialects, {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
        OPENCLAW_SELECTED_SHA: selectedSha,
        OPENCLAW_TOOLING_SHA: "b".repeat(40),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "jsonl|legacy|legacy|legacy-marked-prompt|local-basic,remote-non-interactive,reset,channels,skills",
    );
  });

  it.each([
    {
      name: "producer fragments",
      source:
        "type Params = {\n  fragments?: RuntimeContextFragment[];\n};\nconst fragments = params.fragments?.filter(Boolean);\n",
      expected: "producer-fragments",
    },
    {
      name: "mixed producer and marker extraction",
      source:
        "import { extractInternalRuntimeContext } from '../../internal-runtime-context.js';\ntype Params = {\n  fragments?: RuntimeContextFragment[];\n  modelPrompt?: string;\n};\nconst fragments = params.fragments?.filter(Boolean);\n",
      error: "unable to resolve frozen runtime-context input contract",
    },
    {
      name: "unknown shape",
      source: "export const runtimeContext = true;\n",
      error: "unable to resolve frozen runtime-context input contract",
    },
  ])("classifies $name from the selected source", ({ source, expected, error }) => {
    const root = tempDirs.make("openclaw-frozen-target-runtime-context-");
    const sourcePath = path.join(
      root,
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts",
    );
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const selectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_resolve_frozen_core_harness_capabilities "$2"; printf "%s\\n" "$OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE"',
        "test",
        stageScriptPath,
        root,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: selectedSha,
          OPENCLAW_TOOLING_SHA: "b".repeat(40),
        },
      },
    );

    if (expected) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
      return;
    }
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(error);
  });

  it.each([
    "src/agents/subagent-announce.live.test.ts",
    "src/agents/subagents/announce/subagent-announce.live.test.ts",
  ])("resolves the staged announce test by unique basename: %s", (relativePath) => {
    const root = tempDirs.make("openclaw-live-stage-announce-");
    mkdirSync(path.join(root, path.dirname(relativePath)), { recursive: true });
    writeFileSync(path.join(root, relativePath), "");

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$2"; relative="$(openclaw_live_resolve_unique_staged_file "$1/src/agents" subagent-announce.live.test.ts)"; printf "src/agents/%s\\n" "$relative"',
        "test",
        root,
        stageScriptPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(relativePath);
  });

  it("rejects missing or ambiguous staged announce tests", () => {
    const root = tempDirs.make("openclaw-live-stage-announce-invalid-");
    const command = [
      "-c",
      'set -euo pipefail; source "$2"; openclaw_live_resolve_unique_staged_file "$1/src/agents" subagent-announce.live.test.ts',
      "test",
      root,
      stageScriptPath,
    ];

    const missing = spawnSync("bash", command, { encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("no staged file matched");

    for (const directory of ["old", "current"]) {
      mkdirSync(path.join(root, "src", "agents", directory), { recursive: true });
      writeFileSync(
        path.join(root, "src", "agents", directory, "subagent-announce.live.test.ts"),
        "",
      );
    }
    const ambiguous = spawnSync("bash", command, { encoding: "utf8" });
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain("multiple staged files matched");
  });

  it("keeps repo-local generated artifacts out of the source copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=.artifacts");
    expect(script).toContain('node "$scripts_dir/live-docker-stage-private-sdk-exports.mjs"');
  });

  it("adds private SDK source exports only to the disposable source stage", () => {
    const root = tempDirs.make("openclaw-live-stage-sdk-");
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(root, "src", "plugin-sdk"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" } }),
    );
    writeFileSync(
      path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(["keyed-async-queue"]),
    );
    writeFileSync(path.join(root, "src", "plugin-sdk", "keyed-async-queue.ts"), "export {};\n");

    addStagedPrivatePluginSdkExports(root);

    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.exports).toEqual({
      "./plugin-sdk/core": "./dist/plugin-sdk/core.js",
      "./plugin-sdk/keyed-async-queue": {
        types: "./src/plugin-sdk/keyed-async-queue.ts",
        default: "./src/plugin-sdk/keyed-async-queue.ts",
      },
    });
  });

  it("keeps host-only generated registry state out of the container copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=workspace");
    expect(script).toContain("--exclude=sandboxes");
    expect(script).toContain("--exclude=plugins/installs.json");
    expect(script).toContain("--exclude=plugins/installs.json.migrated");
    expect(script).toContain(
      `db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run("plugins.installedIndex");`,
    );
    expect(script).toContain("PRAGMA secure_delete = ON");
    expect(script).toContain("VACUUM");
    expect(script).toContain("host-absolute paths");
  });
});
