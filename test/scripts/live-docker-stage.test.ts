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
import { afterEach, describe, expect, it, vi } from "vitest";
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
    // Corruption controls own loose objects; automatic packing would move the target first.
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
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

describe("frozen selected consumer ownership", () => {
  const runtimePath = "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts";
  const typedFiles = [
    "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
    "scripts/e2e/lib/release-scenarios/assertions.mjs",
    "scripts/e2e/lib/fixtures/mock-openai-config.mjs",
  ];

  function runConsumer(
    source: ReturnType<typeof committedSourceFixture>,
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
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: authorized ? "1" : "0",
        OPENCLAW_SELECTED_SHA: authorized ? source.sha : "",
        OPENCLAW_TOOLING_SHA: authorized ? "b".repeat(40) : "",
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
      const source = committedSourceFixture({
        "package.json": '{"type":"module","version":"2026.7.33"}\n',
        [runtimePath]: "unknown runtime-context contract\n",
        ...Object.fromEntries(
          typedFiles.map((relative) => [relative, "selected fixture; never execute\n"]),
        ),
      });
      if (runtime === "missing blob") {
        const object = source.git("rev-parse", `${source.sha}:${runtimePath}`);
        rmSync(path.join(source.root, ".git/objects", object.slice(0, 2), object.slice(2)));
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
    const source = committedSourceFixture({
      "package.json": '{"type":"module","version":"2026.7.33"}\n',
      [runtimePath]: "unknown runtime-context contract\n",
      ...Object.fromEntries(
        typedFiles.map((relative) => [relative, "selected fixture; never execute\n"]),
      ),
    });
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
    { consumer: "openai-chat-tools", supported: false, authorized: false },
    { consumer: "openai-chat-tools", supported: false, authorized: true },
    { consumer: "openai-chat-tools", supported: true, authorized: true },
  ])(
    "derives $consumer cold mode (supported=$supported, authorized=$authorized)",
    ({ consumer, supported, authorized }) => {
      const source = committedSourceFixture({
        "package.json": '{"type":"module","version":"2026.9.4"}',
        [runtimePath]:
          "fragments?: RuntimeContextFragment[];\nconst fragments = params.fragments?.filter",
        "src/config/zod-schema.session.ts":
          "export const SessionSchema = z.object({ maintenance: z.object({ pruneAfter: PositiveDurationSchema.optional() }) });",
        "src/config/zod-schema.session-config.ts": supported ? "coldStorage: z.object({})" : null,
      });
      const { result, args } = runConsumer(source, consumer, { authorized, dockerStatus: 0 });
      expect(result.status, result.stderr).toBe(0);
      const mode = authorized && !supported ? "unsupported" : "required";
      expect(args).toContain(`OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE=${mode}`);
      if (consumer === "openai-chat-tools") {
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
          mode === "required"
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
      }
    },
  );

  it.each(["scripts/e2e/lib/release-typed-onboarding/scenario.sh"])(
    "rejects an unreadable typed companion %s before Docker",
    (relative) => {
      const source = committedSourceFixture({
        "package.json": '{"type":"module","version":"2026.7.33"}\n',
        ...Object.fromEntries(typedFiles.map((file) => [file, `${file}\n`])),
      });
      const object = source.git("rev-parse", `${source.sha}:${relative}`);
      rmSync(path.join(source.root, ".git/objects", object.slice(0, 2), object.slice(2)));
      const { result, args } = runConsumer(source, "release-typed-onboarding", { dockerStatus: 0 });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain("unable to read selected source");
      expect(args).toEqual([]);
    },
  );
});

describe("frozen committed source errors", () => {
  const metadata = "scripts/print-cli-backend-live-metadata.ts";

  function invoke(
    source: { root: string; sha: string },
    command: string,
    env: Record<string, string> = {},
  ) {
    return spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; source "$1"; ${command}`,
        "test",
        stageScriptPath,
        source.root,
        repoRoot,
      ],
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

  it("preserves real read-failure injection under inherited automatic Git maintenance", () => {
    const config = { "gc.auto": "1", "gc.autoDetach": "false", "maintenance.strategy": "gc" };
    vi.stubEnv("GIT_CONFIG_COUNT", String(Object.keys(config).length));
    for (const [index, [key, value]] of Object.entries(config).entries()) {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key);
      vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value);
    }
    try {
      const source = committedSourceFixture({
        [metadata]: "unavailable source bytes",
        // Git samples directory 17/ for its loose-object auto-GC threshold.
        "gc-sample-a": "gc sample 376\n",
        "gc-sample-b": "gc sample 568\n",
        "gc-sample-c": "gc sample 675\n",
      });
      removeObject(source, `${source.sha}:${metadata}`);
      const reader = createFrozenTargetSource(source.root, source.sha);
      expect(() => reader.readText(metadata)).toThrow("unable to read selected source");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads committed text through the imported API and distinguishes absent from unreadable blobs", () => {
    const committedText = "selected committed text\n";
    const source = committedSourceFixture({ [metadata]: committedText });
    writeFileSync(path.join(source.root, metadata), "dirty worktree decoy\n");
    const reader = createFrozenTargetSource(source.root, source.sha);
    expect(reader.readText(metadata)).toBe(committedText);
    expect(reader.readText("scripts/absent.ts")).toBeNull();

    removeObject(source, `${source.sha}:${metadata}`);
    expect(() => reader.readText(metadata)).toThrow();
    const freshReader = createFrozenTargetSource(source.root, source.sha);
    expect(() => freshReader.readText(metadata)).toThrow();
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
      expect(() =>
        createFrozenTargetSource(source.root, commit).readText("contract.txt"),
      ).toThrow();
    },
  );

  it.each([
    ["plugin_harness_capabilities", "scripts/e2e/lib/plugins/assertions.mjs"],
    ["session_cold_storage_contract", "src/config/zod-schema.session-config.ts"],
    ["runtime_context_contract", "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts"],
  ])("propagates %s read failure at %s", (resolver, relative) => {
    const source = committedSourceFixture({
      "scripts/e2e/lib/plugins/assertions.mjs": "function assertPluginTgzRemoved() {}",
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts":
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

  it.each(["../package.json"])(
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
});

describe("live Docker state staging", () => {
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

  function stagedPackageMetadataFixture(metadata: string) {
    const root = tempDirs.make("openclaw-live-stage-packages-");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"));
    writeFixturePackageSpecParser(root);
    writeFileSync(path.join(root, "scripts", "print-cli-backend-live-metadata.ts"), metadata);
    return root;
  }

  it.each([{ geminiKey: "test-gemini-key", googleKey: "", expectedType: "gemini-api-key" }])(
    "selects $expectedType from the supplied Gemini credentials",
    (testCase) => {
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
    },
  );

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

  it.each([{ entrypoint: "scripts/test-live.mjs", expected: "scripts/test-live.mjs -- target" }])(
    "runs the staged $entrypoint live runner",
    ({ entrypoint, expected }) => {
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
    },
  );

  it("rejects malformed staged package metadata before npm runs", () => {
    const root = stagedPackageMetadataFixture(
      'export async function resolveCliBackendDockerPackages() { return ["--force"]; }\n',
    );
    const binDir = path.join(root, "bin");
    const installLog = path.join(root, "installs.log");
    mkdirSync(binDir);
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

  it("keeps a matching frozen-source capability under pipefail", () => {
    const { root, sha: selectedSha } = committedSourceFixture({
      "scripts/e2e/lib/plugins/assertions.mjs": `function assertPluginTgzRemoved()\n${"x\n".repeat(100_000)}`,
    });

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

  it.each([
    {
      name: "mixed producer and marker extraction",
      source:
        "import { extractInternalRuntimeContext } from '../../internal-runtime-context.js';\ntype Params = {\n  fragments?: RuntimeContextFragment[];\n  modelPrompt?: string;\n};\nconst fragments = params.fragments?.filter(Boolean);\n",
      error: "unable to resolve frozen runtime-context input contract",
    },
  ])("classifies $name from the selected source", ({ source, error }) => {
    const { root, sha: selectedSha } = committedSourceFixture({
      "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts": source,
    });

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_resolve_frozen_runtime_context_contract "$2"; printf "%s\\n" "$OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE"',
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

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(error);
  });

  it.each(["src/agents/subagent-announce.live.test.ts"])(
    "resolves the staged announce test by unique basename: %s",
    (relativePath) => {
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
    },
  );

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
