import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundledExtensionManifestErrors } from "../scripts/lib/bundled-extension-manifest.ts";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { resolveNpmJsonEntries } from "../scripts/lib/npm-json-output.mts";
import { createWorkspaceBootstrapSmokeEnv } from "../scripts/lib/workspace-bootstrap-smoke.mts";
import {
  collectAppcastSparkleVersionErrors,
  collectForbiddenPackContentPaths,
  collectSkillShellScriptExecutableErrors,
  createPackedBundledPluginActivationSmokeEnv,
  createPackedCompletionSmokeEnv,
  createPackedCliSmokeEnv,
  resolvePackedTarballPath,
  runReleaseCheckCommand,
  writePackedBundledPluginActivationConfig,
} from "../scripts/release-check.ts";
import { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } from "../src/cli/completion-runtime.ts";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-"));
  tempRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();
const smokeHome = { HOME: "/tmp/smoke-home", OPENCLAW_STATE_DIR: "/tmp/smoke-state" };
const ambientEnv = {
  PATH: "/usr/bin",
  HOME: "/tmp/original-home",
  TMPDIR: "/tmp/original-tmp",
  OPENAI_API_KEY: "real-secret",
  OPENCLAW_CONFIG_PATH: "/tmp/leaky-config.json",
};
const isolatedEnv = (home: string) => ({
  PATH:
    process.platform === "win32"
      ? `${dirname(process.execPath)};C:\\Windows\\System32;C:\\Windows`
      : `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: ambientEnv.TMPDIR,
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_SUPPRESS_NOTES: "1",
  OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_SHARED_CREDENTIALS_FILE: join(home, ".aws", "credentials"),
  AWS_CONFIG_FILE: join(home, ".aws", "config"),
});

// Prepare the public SDK graph through the test runner before the consumer test deadline.
await import("openclaw/plugin-sdk/channel-outbound");

it("requires lane-floor appcast builds on and after lane-floor cutover", () => {
  const xml =
    "<rss><channel><item><title>2026.3.1</title><sparkle:shortVersionString>2026.3.1</sparkle:shortVersionString><sparkle:version>202603010</sparkle:version></item></channel></rss>";

  expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
    "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
  ]);
});

describe("packed CLI smoke", () => {
  it("keeps generated dynamic imports opaque to tsx's source lexer", () => {
    expect(readFileSync("scripts/release-check.ts", "utf8")).not.toContain("import(");
  });

  it("builds a packed CLI smoke env with packaged-install guardrails", () => {
    expect(
      createPackedCliSmokeEnv(
        {
          ...ambientEnv,
          USERPROFILE: "/tmp/original-profile",
          SystemRoot: "C:\\Windows",
          GITHUB_TOKEN: "redacted",
        },
        smokeHome,
      ),
    ).toEqual({
      ...isolatedEnv(smokeHome.HOME),
      ...smokeHome,
      ComSpec: join("C:\\Windows", "System32", "cmd.exe"),
      APPDATA: join("/tmp/smoke-home", "AppData", "Roaming"),
      LOCALAPPDATA: join("/tmp/smoke-home", "AppData", "Local"),
      SystemRoot: "C:\\Windows",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    });
  });

  it("isolates bundled plugin activation from ambient OpenClaw state", () => {
    const env = createPackedBundledPluginActivationSmokeEnv(
      { HOME: "/tmp/operator-home", OPENCLAW_STATE_DIR: "/tmp/operator-state" },
      "/tmp/release-check",
    );

    const homeDir = join("/tmp/release-check", "activation-home");
    expect(env).toMatchObject({
      HOME: homeDir,
      OPENCLAW_STATE_DIR: join(homeDir, ".openclaw"),
    });
  });

  it("keeps bundled plugin activation on the built-in runtime", () => {
    const homeDir = fixture();
    writePackedBundledPluginActivationConfig(homeDir);
    const config = JSON.parse(
      readFileSync(join(homeDir, ".openclaw", "openclaw.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(config).toMatchObject({
      agents: { defaults: { models: { "openai/*": { agentRuntime: { id: "openclaw" } } } } },
      channels: { telegram: { enabled: true } },
      plugins: { enabled: true, allow: ["telegram"], entries: { telegram: { enabled: true } } },
    });
    expect(config).not.toHaveProperty("models");
  });

  it("does not admit provider credentials through smoke overrides", () => {
    const env = createPackedCliSmokeEnv(
      { HOME: "/tmp/original-home" },
      { ...smokeHome, OPENAI_API_KEY: "override-openai-secret" },
    );

    expect(env).toMatchObject(smokeHome);
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("skips plugin command discovery during packed completion cache smoke", () => {
    expect(
      createPackedCompletionSmokeEnv(
        { PATH: "/usr/bin", OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS: "0" },
        smokeHome,
      ),
    ).toEqual({
      PATH: "/usr/bin",
      ...smokeHome,
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
    });
  });
});

describe("runReleaseCheckCommand", () => {
  const runNode = (source: string, limits: { timeoutMs?: number; maxBuffer?: number }) =>
    runReleaseCheckCommand(
      { command: process.execPath, args: ["--eval", source] },
      { stdio: ["ignore", "pipe", "pipe"], ...limits },
    );
  it("bounds commands that ignore termination", () => {
    const startedAt = Date.now();

    expect(() =>
      runNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", { timeoutMs: 100 }),
    ).toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it("bounds captured command output", () => {
    expect(() => runNode("process.stdout.write('x'.repeat(4096))", { maxBuffer: 1024 })).toThrow();
  });
});

it("runs workspace bootstrap with a sterile env instead of maintainer credentials", () => {
  expect(
    createWorkspaceBootstrapSmokeEnv(
      {
        ...ambientEnv,
        ANTHROPIC_API_KEY: "real-secret",
      },
      "/tmp/bootstrap-home",
    ),
  ).toEqual({
    ...isolatedEnv("/tmp/bootstrap-home"),
    OPENCLAW_HOME: "/tmp/bootstrap-home",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  });
});

it.each([
  {
    id: "broken",
    install: { npmSpec: "@openclaw/broken", minHostVersion: "2026.3.14" },
    errors: [
      "bundled extension 'broken' manifest invalid | openclaw.install.minHostVersion must use a semver floor in the form \">=x.y.z[-prerelease][+build]\"",
    ],
  },
  { id: "irc", install: { minHostVersion: ">=2026.3.14" }, errors: [] },
])("validates bundled install metadata for $id", ({ id, install, errors }) => {
  expect(
    collectBundledExtensionManifestErrors([{ id, packageJson: { openclaw: { install } } }]),
  ).toStrictEqual(errors);
});

// Windows does not support Unix executable permission bits.
it.skipIf(process.platform === "win32")("flags non-executable skill shell scripts", () => {
  const script = "skills/openai-whisper-api/scripts/transcribe.sh";
  const root = fixture({ [script]: "#!/usr/bin/env bash\necho test\n" });
  chmodSync(join(root, script), 0o644);
  expect(collectSkillShellScriptExecutableErrors(root)).toEqual([
    "skill shell script is not executable: skills/openai-whisper-api/scripts/transcribe.sh",
  ]);
});

describe("collectForbiddenPackPaths", () => {
  it("blocks root dist chunks that still reference private qa lab sources", () => {
    const tempRoot = fixture({
      "dist/entry.js": "//#region extensions/qa-lab/src/runtime-api.ts\n",
      "CHANGELOG.md": "local QA notes mention extensions/qa-lab/\n",
    });

    expect(collectForbiddenPackContentPaths(["dist/entry.js", "CHANGELOG.md"], tempRoot)).toEqual([
      "dist/entry.js",
    ]);
  });

  it("blocks root plugin SDK declarations that still reference private test helpers", () => {
    const file = "dist/plugin-sdk/channel-test-helpers.d.ts";
    const tempRoot = fixture({ [file]: "//#region src/plugin-sdk/test-helpers/session.ts\n" });

    expect(collectForbiddenPackContentPaths([file], tempRoot)).toEqual([file]);
  });
});

it("packs bundled plugin runtime sidecars only for dynamic boundaries", () => {
  expect(requiredBundledPluginPackPaths).not.toContain(
    bundledDistPluginFile("slack", "runtime-api.js"),
  );
  expect(requiredBundledPluginPackPaths).toContain(
    bundledDistPluginFile("telegram", "runtime-api.js"),
  );
});

it("preserves the unchanged released progress consumer behavior", async () => {
  await import("../scripts/fixtures/packed-plugin-sdk-progress-consumer.js");
});

it("normalizes npm <=11 arrays and npm 12 name-keyed objects", () => {
  const entry = { filename: "openclaw-2026.7.2.tgz", unpackedSize: 120_354_302 };

  expect(resolveNpmJsonEntries([entry])).toEqual([entry]);
  expect(resolveNpmJsonEntries(entry)).toEqual([entry]);
  expect(resolveNpmJsonEntries({ openclaw: entry })).toEqual([entry]);
  expect(resolveNpmJsonEntries({ "@openclaw/demo": entry })).toEqual([entry]);
});

it("rejects path-like npm pack tarball filenames", () => {
  const unsafeFilenames = [
    "../openclaw.tgz",
    "nested/openclaw.tgz",
    "nested\\openclaw.tgz",
    "/tmp/openclaw.tgz",
    "C:\\temp\\openclaw.tgz",
    "openclaw\u0000.tgz",
    "openclaw.tar.gz",
  ];

  for (const filename of unsafeFilenames) {
    expect(() => resolvePackedTarballPath("/tmp/openclaw-pack", [{ filename }])).toThrow(
      "release-check: npm pack reported unsafe tarball filename",
    );
  }
});
