import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createFrozenTargetSource } from "../../scripts/lib/frozen-target-source.mjs";
import { addStagedPrivatePluginSdkExports } from "../../scripts/live-docker-stage-private-sdk-exports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageScriptPath = path.join(repoRoot, "scripts/lib/live-docker-stage.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtimePath = "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts";
const metadataPath = "scripts/print-cli-backend-live-metadata.ts";
const pluginAssertionsPath = "scripts/e2e/lib/plugins/assertions.mjs";
type Source = ReturnType<typeof committedSourceFixture>;

function sourceEnv(source: { sha: string }, authorized = true) {
  return {
    OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: authorized ? "1" : "0",
    OPENCLAW_SELECTED_SHA: authorized ? source.sha : "",
    OPENCLAW_TOOLING_SHA: authorized ? "b".repeat(40) : "",
  };
}

function runStage(command: string, root = repoRoot, env: NodeJS.ProcessEnv = {}, timeout?: number) {
  return spawnSync("bash", ["-c", command, "test", stageScriptPath, root, repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout,
    env: { ...process.env, ...env },
  });
}

function writeFixture(
  root: string,
  relative: string,
  content: string | object,
  executable = false,
) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), {
    mode: executable ? 0o755 : 0o644,
  });
  return file;
}

function makeFixture(files: Record<string, string | object>, prefix = "openclaw-live-stage-") {
  const root = tempDirs.make(prefix);
  for (const [relative, content] of Object.entries(files)) {
    writeFixture(root, relative, content);
  }
  return root;
}

function writeExecutable(root: string, name: string, program: string) {
  return writeFixture(root, `bin/${name}`, `#!/usr/bin/env bash\n${program}\n`, true);
}

function removeObject(source: Source, expression: string) {
  const oid = source.git("rev-parse", expression);
  rmSync(path.join(source.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
}

function committedSourceFixture(files: Record<string, string | null>) {
  const root = tempDirs.make("openclaw-frozen-source-");
  for (const [relative, content] of Object.entries(files)) {
    if (content !== null) {
      writeFixture(root, relative, content);
    }
  }
  const git = (...args: string[]) =>
    // Corruption controls own loose objects; automatic packing would move the target first.
    execFileSync(
      "git",
      [
        ...[
          "commit.gpgsign=false",
          "core.hooksPath=/dev/null",
          "maintenance.auto=false",
          "gc.auto=0",
        ].flatMap((config) => ["-c", config]),
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
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

const typedFiles = [
  "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
  "scripts/e2e/lib/release-scenarios/assertions.mjs",
  "scripts/e2e/lib/fixtures/mock-openai-config.mjs",
];
const typedSource = () =>
  committedSourceFixture({
    "package.json": '{"type":"module","version":"2026.7.33"}\n',
    [runtimePath]: "unknown runtime-context contract\n",
    ...Object.fromEntries(
      typedFiles.map((relative) => [relative, "selected fixture; never execute\n"]),
    ),
  });

function runConsumer(
  source: Source,
  consumer: string,
  { authorized = true, dockerStatus = 91 } = {},
) {
  const bin = path.join(source.root, "bin");
  const dockerLog = path.join(source.root, "docker.log");
  const packagePath = path.join(source.root, "fixture.tgz");
  const profilePath = path.join(source.root, "fixture.profile");
  writeFileSync(profilePath, "OPENAI_API_KEY=synthetic-test-key\n");
  mkdirSync(bin);
  writeFileSync(packagePath, "package bytes are not consumed before the Docker boundary\n");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\nprintf '%s\\0' "$@" >> "$FIXTURE_DOCKER_LOG"\nexit ${dockerStatus}\n`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [`scripts/e2e/${consumer}-docker.sh`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: source.root,
      FIXTURE_DOCKER_LOG: dockerLog,
      OPENCLAW_OPENAI_CHAT_TOOLS_PROFILE_FILE: profilePath,
      OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE: "unsupported",
      OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "",
      OPENCLAW_SKIP_DOCKER_BUILD: "1",
      OPENCLAW_DOCKER_E2E_REPO_ROOT: source.root,
      ...sourceEnv(source, authorized),
    },
  });
  const args = existsSync(dockerLog)
    ? readFileSync(dockerLog, "utf8").split("\0").filter(Boolean)
    : [];
  return { result, args };
}

it.each([
  { consumer: "onboard", runtime: "unknown" },
  { consumer: "session-runtime-context", runtime: "missing blob" },
])(
  "runs only the $consumer source contract with $runtime runtime-context source",
  ({ consumer, runtime }) => {
    const source = typedSource();
    if (runtime === "missing blob") {
      removeObject(source, `${source.sha}:${runtimePath}`);
    }
    const { result, args } = runConsumer(source, consumer);
    if (consumer === "session-runtime-context") {
      expect(result.status, result.stderr).toBe(2);
      expect(args).toEqual([]);
      expect(result.stderr).toContain("unable to read selected source");
    } else {
      expect(args.length, result.stderr).toBeGreaterThan(0);
      expect(result.stderr).not.toContain("runtime-context");
    }
  },
);

it.each([
  { contract: "shipped tuple", authorized: true },
  { contract: "authorization off", authorized: false },
])("mounts the typed onboarding $contract", ({ authorized }) => {
  const source = typedSource();
  const { result, args } = runConsumer(source, "release-typed-onboarding", {
    authorized,
    dockerStatus: 0,
  });
  expect(result.status, result.stderr).toBe(0);
  for (const relative of typedFiles) {
    const selectedRoot = authorized ? source.root : repoRoot;
    const mount = `${selectedRoot}/${relative}:/app/${relative}:ro`;
    expect(args.filter((arg) => arg.endsWith(`:/app/${relative}:ro`))).toEqual([mount]);
  }
});

it.each([
  { consumer: "openai-chat-tools", supported: false, authorized: false, legacy: false },
  { consumer: "openai-chat-tools", supported: false, authorized: true, legacy: false },
  { consumer: "openai-chat-tools", supported: true, authorized: true, legacy: false },
  { consumer: "openai-chat-tools", supported: true, authorized: true, legacy: true },
])(
  "derives $consumer cold mode (supported=$supported, authorized=$authorized, legacy=$legacy)",
  ({ consumer, supported, authorized, legacy }) => {
    const source = committedSourceFixture({
      "package.json": '{"type":"module","version":"2026.9.4"}',
      [runtimePath]:
        "fragments?: RuntimeContextFragment[];\nconst fragments = params.fragments?.filter",
      "src/config/zod-schema.session.ts":
        "export const SessionSchema = z.object({ maintenance: z.object({ pruneAfter: PositiveDurationSchema.optional() }) });",
      "src/config/zod-schema.session-config.ts": supported ? "coldStorage: z.object({})" : null,
      "src/config/sessions/session-cold-storage-worker.ts": supported
        ? legacy
          ? 'db.deleteFrom("transcript_events").where("session_id", "=", sessionId)'
          : "retainSessionColdNavigationInTransaction(database, sessionId)"
        : null,
    });
    const { result, args } = runConsumer(source, consumer, { authorized, dockerStatus: 0 });
    expect(result.status, result.stderr).toBe(0);
    const mode = authorized && !supported ? "unsupported" : legacy ? "legacy" : "required";
    expect(args).toContain(`OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE=${mode}`);
    const configPath = path.join(source.root, "config.json");
    const configResult = spawnSync(
      process.execPath,
      ["scripts/e2e/lib/openai-chat-tools/write-config.mjs"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: source.root,
          OPENCLAW_TEST_WORKSPACE_DIR: path.join(source.root, "workspace"),
          OPENCLAW_OPENAI_CHAT_TOOLS_MODEL: "openai/gpt-5.4-mini",
          OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token",
          OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE: mode,
        },
      },
    );
    expect(configResult.status, configResult.stderr).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.session).toEqual(
      mode !== "unsupported"
        ? {
            maintenance: {
              mode: "warn",
              pruneAfter: "3650d",
              archiveDashboardAfter: false,
              maxDiskBytes: false,
              coldStorage: { enabled: true, afterDays: 30 },
            },
          }
        : undefined,
    );
    expect(config.gateway.http.endpoints.chatCompletions.enabled).toBe(true);
    expect(config.tools).toEqual({ allow: ["get_weather"] });
  },
);

it("refuses an unrecognized frozen cold writer before Docker", () => {
  const source = committedSourceFixture({
    "src/config/zod-schema.session-config.ts": "coldStorage: z.object({})",
    "src/config/sessions/session-cold-storage-worker.ts": "unknown archive writer",
  });
  const { result, args } = runConsumer(source, "openai-chat-tools", { dockerStatus: 0 });
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain("unable to resolve frozen cold transcript archival contract");
  expect(args).toEqual([]);
});

it("rejects an unreadable typed companion before Docker", () => {
  const relative = typedFiles[0]!;
  const source = typedSource();
  removeObject(source, `${source.sha}:${relative}`);
  const { result, args } = runConsumer(source, "release-typed-onboarding", { dockerStatus: 0 });
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain("unable to read selected source");
  expect(args).toEqual([]);
});
const metadata = metadataPath;

function invoke(source: Source, command: string, env: NodeJS.ProcessEnv = {}) {
  return runStage(
    `set -euo pipefail; source "$1"; ${command}`,
    source.root,
    { ...sourceEnv(source), ...env },
    10_000,
  );
}

it("reads only committed source and preserves read failures under inherited Git maintenance", () => {
  const config = { "gc.auto": "1", "gc.autoDetach": "false", "maintenance.strategy": "gc" };
  vi.stubEnv("GIT_CONFIG_COUNT", String(Object.keys(config).length));
  for (const [index, [key, value]] of Object.entries(config).entries()) {
    vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key);
    vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value);
  }
  try {
    const source = committedSourceFixture({
      [metadata]: "selected committed text\n",
      // Git samples directory 17/ for its loose-object auto-GC threshold.
      "gc-sample-a": "gc sample 376\n",
      "gc-sample-b": "gc sample 568\n",
      "gc-sample-c": "gc sample 675\n",
    });
    writeFileSync(path.join(source.root, metadata), "dirty worktree decoy\n");
    const reader = createFrozenTargetSource(source.root, source.sha);
    expect(reader.readText(metadata)).toBe("selected committed text\n");
    expect(reader.readText("scripts/absent.ts")).toBeNull();
    removeObject(source, `${source.sha}:${metadata}`);
    expect(() => reader.readText(metadata)).toThrow("unable to read selected source");
    expect(() => createFrozenTargetSource(source.root, source.sha).readText(metadata)).toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(["tree", "blob"] as const)(
  "rejects a wrong-type %s reference even when Git can dereference it",
  (type) => {
    const source = committedSourceFixture({ "contract.txt": "committed contract" });
    const objectFile = path.join(source.root, "fixture-object");
    const writeObject = (kind: string, content: string | Buffer) => {
      writeFileSync(objectFile, content);
      return source.git("hash-object", "-w", "--literally", "-t", kind, objectFile);
    };
    let wrongOid = source.sha;
    let tree = wrongOid;
    if (type === "blob") {
      const blob = source.git("rev-parse", `${source.sha}:contract.txt`);
      wrongOid = writeObject(
        "tag",
        `object ${blob}\ntype blob\ntag fixture\ntagger Test <test@example.invalid> 1 +0000\n\nfixture\n`,
      );
      tree = writeObject(
        "tree",
        Buffer.concat([Buffer.from("100644 contract.txt\0"), Buffer.from(wrongOid, "hex")]),
      );
    }
    const commit = writeObject(
      "commit",
      `${source.git("cat-file", "commit", source.sha).replace(/^tree [0-9a-f]{40}/u, `tree ${tree}`)}\n`,
    );
    source.git("update-ref", "HEAD", commit);
    // Typed cat-file accepts these conversions; source identity must still reject them.
    expect(source.git("cat-file", type, wrongOid).length).toBeGreaterThan(0);
    expect(() => createFrozenTargetSource(source.root, commit).readText("contract.txt")).toThrow();
  },
);

it.each([
  ["plugin_harness_capabilities", pluginAssertionsPath],
  ["session_cold_storage_contract", "src/config/zod-schema.session-config.ts"],
  ["runtime_context_contract", runtimePath],
])("propagates %s read failure at %s", (resolver, relative) => {
  const source = committedSourceFixture({
    [pluginAssertionsPath]: "function assertPluginTgzRemoved() {}",
    [runtimePath]:
      "fragments?: RuntimeContextFragment[];\nconst fragments = params.fragments?.filter",
    [relative]: "unavailable source bytes",
  });
  removeObject(source, `${source.sha}:${relative}`);
  const result = invoke(
    source,
    `status=0; openclaw_resolve_frozen_${resolver} "$2" "$3" || status=$?; exit "$status"`,
  );
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain("unable to read selected source");
});

it.each(["symlink", "gitlink"] as const)(
  "rejects a %s substitution for a selected file",
  (kind) => {
    const source = committedSourceFixture({ [metadata]: "marker\n" });
    rmSync(path.join(source.root, metadata));
    if (kind === "symlink") {
      symlinkSync("missing", path.join(source.root, metadata));
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

it("rejects an unsafe path instead of treating it as absent", () => {
  const source = committedSourceFixture({ "package.json": "{}\n" });
  const result = invoke(
    source,
    'status=0; openclaw_frozen_target_source_has_path "$2" "../package.json" || status=$?; exit "$status"',
  );
  expect(result.status, result.stderr).toBe(2);
});
function stagedPackageMetadataFixture(sourceText: string) {
  const root = makeFixture({
    [metadataPath]: sourceText,
    "src/infra/npm-registry-spec.ts": String.raw`
export function parseRegistryNpmSpec(spec: string) {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9][a-z0-9._-]*)?$/u.test(spec)
    ? { raw: spec }
    : null;
}
`,
  });
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"));
  return root;
}

it("selects gemini-api-key from the supplied Gemini credentials", () => {
  const home = tempDirs.make("openclaw-live-stage-gemini-");
  const settingsPath = writeFixture(home, ".gemini/settings.json", {
    security: { auth: { selectedType: "oauth-personal" } },
    privacy: { usageStatisticsEnabled: false },
  });

  const result = runStage('source "$1"; openclaw_live_stage_gemini_auth', repoRoot, {
    HOME: home,
    GEMINI_API_KEY: "test-gemini-key",
    GOOGLE_API_KEY: "",
    GOOGLE_GENAI_USE_VERTEXAI: "",
  });

  expect(result.status, result.stderr).toBe(0);
  const settings = readFileSync(settingsPath, "utf8");
  const parsed = JSON.parse(settings);
  expect(parsed.security.auth).toMatchObject({
    selectedType: "gemini-api-key",
    enforcedType: "gemini-api-key",
  });
  expect(parsed.privacy).toEqual({ usageStatisticsEnabled: false });
  expect(settings).not.toContain("test-gemini-key");
  expect(settings).not.toContain("test-google-key");
});

it("installs missing CLI executables and refreshes pinned packages", () => {
  const root = tempDirs.make("openclaw-live-stage-cli-");
  const binDir = path.join(root, "bin");
  writeExecutable(
    root,
    "npm",
    'set -eu\nprintf "%s\\n" "$3" >> "$INSTALL_LOG"\nprintf "#!/usr/bin/env bash\\nprintf fixture-ok" > "$CLI_PATH"\nchmod +x "$CLI_PATH"',
  );
  writeExecutable(
    root,
    "timeout",
    'set -euo pipefail\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"',
  );
  const installLog = path.join(root, "installs.log");
  const result = runStage(
    'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; "$CLI_PATH"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend@1.0.0 10',
    root,
    {
      PATH: `${binDir}:${process.env.PATH}`,
      CLI_PATH: path.join(binDir, "fixture"),
      INSTALL_LOG: installLog,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("fixture-ok");
  expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual([
    "@fixture/backend",
    "@fixture/backend@1.0.0",
  ]);
});

it("runs the staged scripts/test-live.mjs live runner", () => {
  const root = tempDirs.make("openclaw-live-stage-entrypoint-");
  const binDir = path.join(root, "bin");
  const callsPath = path.join(root, "calls");
  writeFixture(root, "scripts/test-live.mjs", "");
  writeExecutable(root, "node", 'set -eu\nprintf "%s\\n" "$*" > "$CALLS_PATH"');

  const result = runStage(
    'set -euo pipefail; cd "$2"; source "$1"; openclaw_live_run_staged_script scripts/test-live -- target',
    root,
    { PATH: `${binDir}:${process.env.PATH}`, CALLS_PATH: callsPath },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(callsPath, "utf8").trim()).toBe("scripts/test-live.mjs -- target");
});

it("rejects malformed staged package metadata before npm runs", () => {
  const root = stagedPackageMetadataFixture(
    'export async function resolveCliBackendDockerPackages() { return ["--force"]; }\n',
  );
  const binDir = path.join(root, "bin");
  const installLog = path.join(root, "installs.log");
  writeExecutable(root, "npm", 'printf "%s\\n" "$*" >> "$INSTALL_LOG"');

  const result = runStage(
    'set -euo pipefail; cd "$2"; source "$1"; openclaw_live_prepare_cli_backend_docker_packages "" ""',
    root,
    { INSTALL_LOG: installLog, PATH: `${binDir}:${process.env.PATH}` },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("invalid Docker CLI package");
  expect(() => readFileSync(installLog, "utf8")).toThrow();
});

it("falls back without frozen context but fails malformed authorization", () => {
  const run = (env: Record<string, string>) =>
    runStage(
      'set -euo pipefail; source "$1"; openclaw_resolve_frozen_target_file "$2" missing/path fallback',
      repoRoot,
      env,
    );

  const absent = run({});
  expect(absent.status).toBe(0);
  expect(absent.stdout).toBe("fallback\n");

  const malformed = run({ OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "yes" });
  expect(malformed.status).toBe(2);
  expect(malformed.stderr).toContain("invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS");
});

it("keeps a matching frozen-source capability under pipefail", () => {
  const { root, sha: selectedSha } = committedSourceFixture({
    "scripts/e2e/lib/plugins/assertions.mjs": `function assertPluginTgzRemoved()\n${"x\n".repeat(100_000)}`,
  });

  const result = runStage(
    'set -euo pipefail; source "$1"; openclaw_frozen_target_source_contains "$2" scripts/e2e/lib/plugins/assertions.mjs "function assertPluginTgzRemoved()"',
    root,
    { OPENCLAW_SELECTED_SHA: selectedSha },
  );

  expect(result.status, result.stderr).toBe(0);
});

it("classifies mixed producer and marker extraction from the selected source", () => {
  const source = committedSourceFixture({
    [runtimePath]:
      "import { extractInternalRuntimeContext } from '../../internal-runtime-context.js';\ntype Params = {\n  fragments?: RuntimeContextFragment[];\n  modelPrompt?: string;\n};\nconst fragments = params.fragments?.filter(Boolean);\n",
  });

  const result = runStage(
    'set -euo pipefail; source "$1"; openclaw_resolve_frozen_runtime_context_contract "$2"; printf "%s\\n" "$OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE"',
    source.root,
    sourceEnv(source),
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("unable to resolve frozen runtime-context input contract");
});

it("resolves the staged announce test by unique basename", () => {
  const relativePath = "src/agents/subagent-announce.live.test.ts";
  const root = makeFixture({ [relativePath]: "" });

  const result = runStage(
    'set -euo pipefail; source "$1"; relative="$(openclaw_live_resolve_unique_staged_file "$2/src/agents" subagent-announce.live.test.ts)"; printf "src/agents/%s\\n" "$relative"',
    root,
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(relativePath);
});

it("adds private SDK source exports only to the disposable source stage", () => {
  const root = makeFixture({
    "package.json": {
      exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" },
    },
    "scripts/lib/plugin-sdk-private-local-only-subpaths.json": ["keyed-async-queue"],
    "src/plugin-sdk/keyed-async-queue.ts": "export {};\n",
  });

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
  for (const fragment of [
    ...["workspace", "sandboxes", "plugins/installs.json", "plugins/installs.json.migrated"].map(
      (name) => `--exclude=${name}`,
    ),
    `db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run("plugins.installedIndex");`,
    "PRAGMA secure_delete = ON",
    "VACUUM",
    "host-absolute paths",
  ]) {
    expect(script).toContain(fragment);
  }
});
