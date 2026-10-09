// Release check tests cover release validation script behavior.
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
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
import { resolveNpmJsonEntries as resolveRuntimeNpmJsonEntries } from "../src/infra/npm-registry-spec.js";

function makeItem(shortVersion: string, sparkleVersion: string, channel?: string): string {
  const channelElement = channel ? `<sparkle:channel>${channel}</sparkle:channel>` : "";
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version>${channelElement}</item>`;
}

function makePackResult(filename: string, unpackedSize: number) {
  return { filename, unpackedSize };
}

const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();

// Prepare the public SDK graph through the test runner before the consumer test deadline.
await import("openclaw/plugin-sdk/channel-outbound");

describe("collectAppcastSparkleVersionErrors", () => {
  it("requires lane-floor builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "202603010")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
    ]);
  });
});

describe("packed CLI smoke", () => {
  it("keeps generated dynamic imports opaque to tsx's source lexer", () => {
    expect(readFileSync("scripts/release-check.ts", "utf8")).not.toContain("import(");
  });

  it("builds a packed CLI smoke env with packaged-install guardrails", () => {
    expect(
      createPackedCliSmokeEnv(
        {
          PATH: "/usr/bin",
          HOME: "/tmp/original-home",
          USERPROFILE: "/tmp/original-profile",
          TMPDIR: "/tmp/original-tmp",
          SystemRoot: "C:\\Windows",
          GITHUB_TOKEN: "redacted",
          OPENAI_API_KEY: "real-secret",
          OPENCLAW_CONFIG_PATH: "/tmp/leaky-config.json",
        },
        { HOME: "/tmp/smoke-home", OPENCLAW_STATE_DIR: "/tmp/smoke-state" },
      ),
    ).toEqual({
      PATH:
        process.platform === "win32"
          ? `${dirname(process.execPath)};C:\\Windows\\System32;C:\\Windows`
          : `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: "/tmp/smoke-home",
      USERPROFILE: "/tmp/smoke-home",
      ComSpec: join("C:\\Windows", "System32", "cmd.exe"),
      APPDATA: join("/tmp/smoke-home", "AppData", "Roaming"),
      LOCALAPPDATA: join("/tmp/smoke-home", "AppData", "Local"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_SHARED_CREDENTIALS_FILE: join("/tmp/smoke-home", ".aws", "credentials"),
      AWS_CONFIG_FILE: join("/tmp/smoke-home", ".aws", "config"),
      TMPDIR: "/tmp/original-tmp",
      SystemRoot: "C:\\Windows",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_STATE_DIR: "/tmp/smoke-state",
    });
  });

  it("isolates bundled plugin activation from ambient OpenClaw state", () => {
    const env = createPackedBundledPluginActivationSmokeEnv(
      {
        HOME: "/tmp/operator-home",
        OPENCLAW_STATE_DIR: "/tmp/operator-state",
      },
      "/tmp/release-check",
    );

    const homeDir = join("/tmp/release-check", "activation-home");
    expect(env).toMatchObject({
      HOME: homeDir,
      OPENCLAW_STATE_DIR: join(homeDir, ".openclaw"),
    });
  });

  it("keeps bundled plugin activation on the built-in runtime", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openclaw-release-activation-config-"));
    try {
      writePackedBundledPluginActivationConfig(homeDir);
      const config = JSON.parse(
        readFileSync(join(homeDir, ".openclaw", "openclaw.json"), "utf8"),
      ) as Record<string, unknown>;

      expect(config).toMatchObject({
        agents: {
          defaults: {
            models: { "openai/*": { agentRuntime: { id: "openclaw" } } },
          },
        },
        channels: { telegram: { enabled: true } },
        plugins: { enabled: true, allow: ["telegram"], entries: { telegram: { enabled: true } } },
      });
      expect(config).not.toHaveProperty("models");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not admit provider credentials through smoke overrides", () => {
    const env = createPackedCliSmokeEnv(
      { HOME: "/tmp/original-home" },
      {
        HOME: "/tmp/smoke-home",
        OPENCLAW_STATE_DIR: "/tmp/smoke-state",
        OPENAI_API_KEY: "override-openai-secret",
      },
    );

    expect(env).toMatchObject({
      HOME: "/tmp/smoke-home",
      OPENCLAW_STATE_DIR: "/tmp/smoke-state",
    });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("skips plugin command discovery during packed completion cache smoke", () => {
    expect(
      createPackedCompletionSmokeEnv(
        {
          PATH: "/usr/bin",
          OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS: "0",
        },
        {
          HOME: "/tmp/smoke-home",
          OPENCLAW_STATE_DIR: "/tmp/smoke-state",
        },
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/smoke-home",
      OPENCLAW_STATE_DIR: "/tmp/smoke-state",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
    });
  });
});

describe("runReleaseCheckCommand", () => {
  it("bounds commands that ignore termination", () => {
    const startedAt = Date.now();

    expect(() =>
      runReleaseCheckCommand(
        {
          command: process.execPath,
          args: ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        },
        { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 100 },
      ),
    ).toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it("bounds captured command output", () => {
    expect(() =>
      runReleaseCheckCommand(
        { command: process.execPath, args: ["--eval", "process.stdout.write('x'.repeat(4096))"] },
        { maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toThrow();
  });
});

describe("workspace bootstrap smoke", () => {
  it("runs with a sterile env instead of maintainer provider credentials", () => {
    expect(
      createWorkspaceBootstrapSmokeEnv(
        {
          PATH: "/usr/bin",
          HOME: "/tmp/original-home",
          TMPDIR: "/tmp/original-tmp",
          OPENAI_API_KEY: "real-secret",
          ANTHROPIC_API_KEY: "real-secret",
          OPENCLAW_CONFIG_PATH: "/tmp/leaky-config.json",
        },
        "/tmp/bootstrap-home",
      ),
    ).toEqual({
      PATH:
        process.platform === "win32"
          ? `${dirname(process.execPath)};C:\\Windows\\System32;C:\\Windows`
          : `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: "/tmp/bootstrap-home",
      USERPROFILE: "/tmp/bootstrap-home",
      OPENCLAW_HOME: "/tmp/bootstrap-home",
      TMPDIR: "/tmp/original-tmp",
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_SHARED_CREDENTIALS_FILE: join("/tmp/bootstrap-home", ".aws", "credentials"),
      AWS_CONFIG_FILE: join("/tmp/bootstrap-home", ".aws", "config"),
    });
  });
});

describe("collectBundledExtensionManifestErrors", () => {
  it("flags invalid bundled extension minHostVersion metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "@openclaw/broken", minHostVersion: "2026.3.14" },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.install.minHostVersion must use a semver floor in the form \">=x.y.z[-prerelease][+build]\"",
    ]);
  });

  it("allows install metadata without npmSpec when only non-publish metadata is present", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "irc",
          packageJson: {
            openclaw: {
              install: { minHostVersion: ">=2026.3.14" },
            },
          },
        },
      ]),
    ).toStrictEqual([]);
  });
});

// This suite exists both as regression coverage and as an intentional CI touchpoint for executable-bit fixes.
// Windows doesn't support Unix permission bits; chmod 0o755 is a no-op and
// statSync().mode never reports execute bits, so these tests are meaningless there.
describe.skipIf(process.platform === "win32")("collectSkillShellScriptExecutableErrors", () => {
  it("flags non-executable shell scripts under skills/*/scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-"));
    const scriptPath = join(root, "skills", "openai-whisper-api", "scripts", "transcribe.sh");
    mkdirSync(join(root, "skills", "openai-whisper-api", "scripts"), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env bash\necho test\n", "utf8");
    chmodSync(scriptPath, 0o644);

    try {
      expect(collectSkillShellScriptExecutableErrors(root)).toEqual([
        "skill shell script is not executable: skills/openai-whisper-api/scripts/transcribe.sh",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectForbiddenPackPaths", () => {
  it("blocks root dist chunks that still reference private qa lab sources", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-release-private-qa-"));

    try {
      mkdirSync(join(tempRoot, "dist"), { recursive: true });
      writeFileSync(
        join(tempRoot, "dist", "entry.js"),
        "//#region extensions/qa-lab/src/runtime-api.ts\n",
        "utf8",
      );
      writeFileSync(join(tempRoot, "CHANGELOG.md"), "local QA notes mention extensions/qa-lab/\n");

      expect(collectForbiddenPackContentPaths(["dist/entry.js", "CHANGELOG.md"], tempRoot)).toEqual(
        ["dist/entry.js"],
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks root plugin SDK declarations that still reference private test helpers", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-release-private-sdk-"));

    try {
      mkdirSync(join(tempRoot, "dist", "plugin-sdk"), { recursive: true });
      writeFileSync(
        join(tempRoot, "dist", "plugin-sdk", "channel-test-helpers.d.ts"),
        "//#region src/plugin-sdk/test-helpers/session.ts\n",
        "utf8",
      );

      expect(
        collectForbiddenPackContentPaths(["dist/plugin-sdk/channel-test-helpers.d.ts"], tempRoot),
      ).toEqual(["dist/plugin-sdk/channel-test-helpers.d.ts"]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("packed install verification", () => {
  it("requires bundled plugin runtime sidecars that dynamic plugin boundaries resolve at runtime", () => {
    expect(requiredBundledPluginPackPaths).not.toContain(
      bundledDistPluginFile("slack", "runtime-api.js"),
    );
    expect(requiredBundledPluginPackPaths).toContain(
      bundledDistPluginFile("telegram", "runtime-api.js"),
    );
  });
});

describe("createPackedPluginSdkTypescriptSmokeProject", () => {
  it("preserves the unchanged released progress consumer behavior", async () => {
    await import("../scripts/fixtures/packed-plugin-sdk-progress-consumer.js");
  });
});

describe("resolveNpmJsonEntries", () => {
  it("normalizes npm <=11 arrays and npm 12 name-keyed objects", () => {
    const entry = makePackResult("openclaw-2026.7.2.tgz", 120_354_302);

    expect(resolveNpmJsonEntries([entry])).toEqual([entry]);
    expect(resolveNpmJsonEntries(entry)).toEqual([entry]);
    expect(resolveNpmJsonEntries({ openclaw: entry })).toEqual([entry]);
    expect(resolveNpmJsonEntries({ "@openclaw/demo": entry })).toEqual([entry]);
    expect(resolveNpmJsonEntries({ openclaw: entry })).toEqual(
      resolveRuntimeNpmJsonEntries({ openclaw: entry }),
    );
  });
});

describe("resolvePackedTarballPath", () => {
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
});
