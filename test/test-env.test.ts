// Test environment tests validate shared env setup helpers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../src/agents/auth-profiles/sqlite.js";
import { isCurrentProcessLaunchdServiceLabel } from "../src/daemon/launchd-current-service.js";
import { detectGatewayRespawnSupervisor } from "../src/infra/supervisor-markers.js";
import { closeOpenClawAgentDatabaseByPath } from "../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPath } from "../src/state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";
import {
  captureFullEnv,
  deleteTestEnvValue,
  setTestEnvValue,
  withEnv,
} from "../src/test-utils/env.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";
import { installTestEnv } from "./test-env.js";

const originalEnv = captureFullEnv();

const tempDirs = new Set<string>();
const cleanupFns: Array<() => void> = [];
const liveFlags = [
  "LIVE",
  "OPENCLAW_LIVE_TEST",
  "OPENCLAW_LIVE_GATEWAY",
  "OPENCLAW_LIVE_USE_REAL_HOME",
  "OPENCLAW_LIVE_TEST_QUIET",
];
const liveHome = {
  OPENCLAW_LIVE_TEST: "1",
  OPENCLAW_LIVE_USE_REAL_HOME: "1",
  OPENCLAW_LIVE_TEST_QUIET: "1",
};

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      deleteTestEnvValue(key);
    } else {
      setTestEnvValue(key, value);
    }
  }
}

function useProfileHome(env: Record<string, string | undefined> = {}) {
  const home = createTempHome();
  writeFile(path.join(home, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");
  setEnv({ HOME: home, USERPROFILE: home, ...env });
  return home;
}

function install(options?: Parameters<typeof installTestEnv>[0]) {
  const result = installTestEnv(options);
  cleanupFns.push(result.cleanup);
  return result;
}

function expectEnvAbsent(keys: string[]) {
  expect(keys.filter((key) => process.env[key] !== undefined)).toEqual([]);
}

// Compare every key without printing ambient credentials in assertion failures.
function changedEnvKeys(expected: NodeJS.ProcessEnv): string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(process.env)])].filter(
    (key) => expected[key] !== process.env[key],
  );
}

function writeFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

function writeHomeFiles(home: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(home, file), content);
  }
}

function expectHomeFiles(home: string, present: string[], absent: string[]): void {
  for (const file of present) {
    expect(fs.existsSync(path.join(home, file)), file).toBe(true);
  }
  for (const file of absent) {
    expect(fs.existsSync(path.join(home, file)), file).toBe(false);
  }
}

function createTempHome(): string {
  return makeTempDir(tempDirs, "openclaw-test-env-real-home-");
}

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
  originalEnv.restore();
  vi.restoreAllMocks();
  vi.doUnmock("node:child_process");
  cleanupTempDirs(tempDirs);
});

describe("installTestEnv", () => {
  it.each([".openclaw", ".claude"])(
    "rolls back live staging failure at %s before another installation",
    (failedDirectory) => {
      const sandbox = makeTempDir(tempDirs, "openclaw-env-acquisition-");
      const realHome = createTempHome();
      writeFile(
        path.join(realHome, ".profile"),
        [
          "export ACQUISITION_PROFILE_ADDED=from-profile",
          "export ACQUISITION_PROFILE_EMPTY=from-profile",
          "export OPENCLAW_TEST_FAST=from-profile",
        ].join("\n"),
      );
      const configPath = path.join(realHome, ".openclaw", "openclaw.json");
      writeFile(configPath, "{}\n");
      writeFile(path.join(realHome, ".claude", "settings.json"), "{}\n");
      vi.spyOn(os, "tmpdir").mockReturnValue(sandbox);

      withEnv(
        {
          HOME: realHome,
          USERPROFILE: realHome,
          OPENCLAW_HOME: realHome,
          OPENCLAW_STATE_DIR: path.join(realHome, ".openclaw"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_AGENT_DIR: path.join(realHome, "caller-agent"),
          PI_CODING_AGENT_DIR: path.join(realHome, "caller-legacy-agent"),
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_USE_REAL_HOME: undefined,
          OPENCLAW_LIVE_TEST_QUIET: "1",
          OPENCLAW_TEST_FAST: "",
          COREPACK_HOME: undefined,
          ACQUISITION_PROFILE_ADDED: undefined,
          ACQUISITION_PROFILE_EMPTY: "",
        },
        () => {
          const callerEnv = { ...process.env };
          const failure = new Error(`staging failed at ${failedDirectory}`);
          const mkdirSync = fs.mkdirSync;
          let failedHome = "";
          const fault = vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
            const home = process.env.HOME;
            if (home && home !== realHome && target === path.join(home, failedDirectory)) {
              failedHome = home;
              throw failure;
            }
            return mkdirSync(target, options);
          });
          try {
            let caught: unknown;
            try {
              install();
            } catch (error) {
              caught = error;
            }
            expect(caught).toBe(failure);
          } finally {
            fault.mockRestore();
          }
          expect(failedHome).not.toBe("");
          expect.soft(changedEnvKeys(callerEnv)).toEqual([]);
          expect.soft(fs.existsSync(failedHome)).toBe(false);
          expect(fs.readdirSync(sandbox)).toEqual([]);
          expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");

          const next = install();
          expect(next.tempHome).not.toBe(failedHome);
          expectEnvAbsent(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]);
          expect(process.env.ACQUISITION_PROFILE_ADDED).toBe("from-profile");
          expect(process.env.ACQUISITION_PROFILE_EMPTY).toBe("from-profile");
          expect(
            fs.readFileSync(path.join(next.tempHome, ".claude", "settings.json"), "utf8"),
          ).toBe("{}\n");
          next.cleanup();
          expect(process.env.HOME).toBe(realHome);
          expect(process.env.OPENCLAW_AGENT_DIR).toBe(callerEnv.OPENCLAW_AGENT_DIR);
          expect(process.env.PI_CODING_AGENT_DIR).toBe(callerEnv.PI_CODING_AGENT_DIR);
          expect(process.env.OPENCLAW_TEST_FAST).toBe("from-profile");
          expect(process.env.ACQUISITION_PROFILE_ADDED).toBe("from-profile");
          expect(fs.readdirSync(sandbox)).toEqual([]);
        },
      );
    },
  );

  it("keeps live tests on a temp HOME while copying config and auth state", () => {
    const realHome = useProfileHome({ OPENCLAW_LIVE_TEST: "1", OPENCLAW_LIVE_TEST_QUIET: "1" });
    const openClawHome = createTempHome();
    const priorIsolatedHome = createTempHome();
    writeFile(
      path.join(openClawHome, "custom-openclaw.json5"),
      `{
        // Preserve provider config, strip host-bound paths.
        agents: {
          defaults: { workspace: "/Users/peter/Projects", agentDir: "/Users/peter/.openclaw/agents/main/agent" },
          entries: { dev: { workspace: "/Users/peter/dev-workspace", agentDir: "/Users/peter/.openclaw/agents/dev/agent" } },
        },
        models: { providers: { custom: { baseUrl: "https://example.test/v1" } } },
        channels: { telegram: { streaming: {
          mode: "block", chunkMode: "newline", block: { enabled: true },
          preview: { chunk: { minChars: 120 } },
        } } },
      }`,
    );
    writeHomeFiles(openClawHome, {
      ".openclaw/credentials/token.txt": "secret\n",
      ".openclaw/external-plugins/glueclaw/openclaw.plugin.json": '{"id":"glueclaw"}\n',
    });
    const realStateDir = path.join(openClawHome, ".openclaw");
    const realAgentDir = path.join(realStateDir, "agents", "main", "agent");
    const liveAuthStore = {
      version: 1,
      profiles: {
        "openai:api-key": {
          type: "api_key",
          provider: "openai",
          keyRef: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_LIVE_OPENAI_KEY",
          },
        },
      },
    };
    const liveAuthState = {
      version: 1,
      order: { openai: ["openai:api-key"] },
    };
    runAuthProfileWriteTransaction(
      realAgentDir,
      (database) => {
        writePersistedAuthProfileStoreRaw(liveAuthStore, realAgentDir, database);
        writePersistedAuthProfileStateRaw(liveAuthState, realAgentDir, database);
      },
      { stateDir: realStateDir },
    );
    cleanupFns.push(() => {
      closeOpenClawAgentDatabaseByPath(resolveAuthProfileDatabasePath(realAgentDir));
      closeOpenClawStateDatabaseByPath(
        resolveOpenClawStateSqlitePath({
          ...process.env,
          OPENCLAW_STATE_DIR: realStateDir,
        }),
      );
    });
    const copiedFiles = {
      ".claude/.credentials.json": '{"accessToken":"token"}\n',
      ".codex/auth.json": '{"OPENAI_API_KEY":"token"}\n',
      ".codex/config.toml": 'model = "gpt-5.4"\n',
      ".gemini/oauth_creds.json": '{"token":"gemini"}\n',
      ".gemini/settings.json": '{"theme":"dark"}\n',
      ".gemini/commands/Cache/review.toml": "prompt\n",
      ".minimax/Cache/credentials.json": "minimax\n",
    };
    writeHomeFiles(realHome, {
      ...copiedFiles,
      ".claude/projects/old-session.jsonl": "session\n",
      ".codex/sessions/2026/02/26/rollout.jsonl": "session\n",
      ".gemini/antigravity-browser-profile/Default/Cache/Cache_Data/blob": "cached-browser-bytes\n",
      ".gemini/antigravity/browser_recordings/session.webm": "recording\n",
      ".gemini/cli-browser-profile/Default/History": "browser-history\n",
      ".gemini/GPUCache/data.bin": "gpu-cache\n",
      ".gemini/Service Worker/CacheStorage/cache.bin": "worker-cache\n",
    });
    fs.mkdirSync(path.join(realHome, ".claude", "settings.local.json"), { recursive: true });

    setTestEnvValue("OPENCLAW_HOME", openClawHome);
    setTestEnvValue("FAL_KEY", "fal-sentinel-not-a-real-key-0123456789");
    setTestEnvValue("OPENAI_API_KEY", "openai-sentinel-not-a-real-key-0123456789");
    setTestEnvValue("TWILIO_AUTH_TOKEN", "twilio-sentinel-not-a-real-token-0123456789");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", "~/custom-openclaw.json5");
    setTestEnvValue("OPENCLAW_TEST_HOME", priorIsolatedHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(priorIsolatedHome, ".openclaw"));

    const testEnv = install();

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.HOME).toBe(testEnv.tempHome);
    expect(process.env.OPENCLAW_HOME).toBeUndefined();
    expect(process.env.OPENCLAW_TEST_HOME).toBe(testEnv.tempHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
    expect(process.env.FAL_KEY).toBe("fal-sentinel-not-a-real-key-0123456789");
    expect(process.env.OPENAI_API_KEY).toBe("openai-sentinel-not-a-real-key-0123456789");
    expect(process.env.TWILIO_AUTH_TOKEN).toBeUndefined();

    const copiedConfigPath = path.join(testEnv.tempHome, ".openclaw", "openclaw.json");
    const copiedConfig: unknown = JSON.parse(fs.readFileSync(copiedConfigPath, "utf8"));
    expect(copiedConfig).toHaveProperty("models.providers.custom", {
      baseUrl: "https://example.test/v1",
    });
    for (const agentPath of ["agents.defaults", "agents.entries.dev"]) {
      expect(copiedConfig).toHaveProperty(agentPath, expect.any(Object));
      expect(copiedConfig).not.toHaveProperty(`${agentPath}.workspace`);
      expect(copiedConfig).not.toHaveProperty(`${agentPath}.agentDir`);
    }
    expect(copiedConfig).toHaveProperty("channels.telegram.streaming", {
      mode: "block",
      chunkMode: "newline",
      block: { enabled: true },
      preview: { chunk: { minChars: 120 } },
    });

    const stagedAgentDir = path.join(testEnv.tempHome, ".openclaw", "agents", "main", "agent");
    expect(inspectPersistedAuthProfileStoreRaw(stagedAgentDir)).toEqual({
      status: "readable",
      raw: liveAuthStore,
    });
    expect(inspectPersistedAuthProfileStateRaw(stagedAgentDir)).toEqual({
      status: "readable",
      raw: liveAuthState,
    });
    expectHomeFiles(
      testEnv.tempHome,
      [
        ".openclaw/credentials/token.txt",
        ".openclaw/external-plugins/glueclaw/openclaw.plugin.json",
        ...Object.keys(copiedFiles),
      ],
      [
        ".openclaw/agents/main/agent/auth-profiles.json",
        ".claude/projects",
        ".claude/settings.local.json",
        ".codex/sessions",
        ".gemini/antigravity-browser-profile",
        ".gemini/antigravity/browser_recordings",
        ".gemini/cli-browser-profile",
        ".gemini/GPUCache",
        ".gemini/Service Worker/CacheStorage",
      ],
    );
  });

  it("allows explicit live runs against the real HOME", () => {
    const realHome = useProfileHome(liveHome);
    const agentDir = path.join(realHome, "caller-agent");
    const legacyAgentDir = path.join(realHome, "caller-legacy-agent");
    setTestEnvValue("OPENCLAW_AGENT_DIR", agentDir);
    setTestEnvValue("PI_CODING_AGENT_DIR", legacyAgentDir);

    const testEnv = installTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.HOME).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
    expect(process.env.OPENCLAW_AGENT_DIR).toBe(agentDir);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(legacyAgentDir);
    testEnv.cleanup();
    expect(process.env.OPENCLAW_AGENT_DIR).toBe(agentDir);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(legacyAgentDir);
  });

  it("keeps hermetic mode isolated when live flags request the real HOME", () => {
    const realHome = useProfileHome({ ...liveHome, LIVE: "1", OPENCLAW_LIVE_GATEWAY: "1" });
    writeFile(path.join(realHome, ".openclaw", "openclaw.json"), '{"live":true}\n');
    writeFile(path.join(realHome, ".openclaw", "credentials", "token.txt"), "secret\n");

    const callerPluginDir = path.join(realHome, "caller-plugins");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", callerPluginDir);
    setTestEnvValue("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    setTestEnvValue("OPENCLAW_HOME", realHome);
    setTestEnvValue("OPENCLAW_AGENT_DIR", path.join(realHome, "caller-agent"));
    setTestEnvValue("PI_CODING_AGENT_DIR", path.join(realHome, "caller-legacy-agent"));

    const testEnv = install({ mode: "hermetic" });

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.HOME).toBe(testEnv.tempHome);
    expect(process.env.TEST_PROFILE_ONLY).toBeUndefined();
    expectEnvAbsent(liveFlags.slice(0, 4));
    expect(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR).not.toBe(callerPluginDir);
    expect(path.basename(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "")).toBe("extensions");
    expect(process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR).toBe("1");
    expectEnvAbsent([
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_HOME",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
    ]);
    expectHomeFiles(
      testEnv.tempHome,
      [],
      [".openclaw/openclaw.json", ".openclaw/credentials/token.txt"],
    );
  });

  it.each(["OPENCLAW_HOME", "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"])(
    "clears and restores %s for normal isolated test runs",
    (key) => {
      const realHome = createTempHome();
      const callerPath = path.join(realHome, "caller-override");
      setTestEnvValue("HOME", realHome);
      setTestEnvValue("USERPROFILE", realHome);
      setTestEnvValue(key, callerPath);

      const testEnv = install();

      expect(testEnv.tempHome).not.toBe(realHome);
      expect(process.env[key]).toBeUndefined();
      setTestEnvValue(key, path.join(testEnv.tempHome, "explicit-override"));

      testEnv.cleanup();
      expect(process.env[key]).toBe(callerPath);
    },
  );

  it.each([
    ["explicit", "tool-cache", "xdg", "local", "tool-cache"],
    ["explicit empty", "", "xdg", "local", ""],
    ["explicit whitespace", " tool-cache ", undefined, undefined, " tool-cache "],
    ["XDG before LOCALAPPDATA", undefined, "xdg", "local", "xdg/node/corepack"],
    ["empty XDG", undefined, "", "local", "node/corepack"],
    ["LOCALAPPDATA", undefined, undefined, "local", "local/node/corepack"],
    ["empty LOCALAPPDATA", undefined, undefined, "", "node/corepack"],
    ["OS home"],
  ])(
    "preserves the %s Corepack cache across HOME isolation and cleanup",
    (_name, corepack?: string, xdg?: string, local?: string, cache?: string) => {
      const realHome = createTempHome();
      withEnv(
        {
          HOME: realHome,
          USERPROFILE: realHome,
          COREPACK_HOME: corepack,
          XDG_CACHE_HOME: xdg,
          XDG_RUNTIME_DIR: path.join(realHome, "runtime"),
          LOCALAPPDATA: local,
        },
        () => {
          const callerEnv = { ...process.env };
          const expected =
            cache === undefined
              ? path.join(
                  os.homedir(),
                  process.platform === "win32" ? "AppData/Local" : ".cache",
                  "node/corepack",
                )
              : corepack === undefined
                ? path.normalize(cache)
                : cache;
          const testEnv = install({ mode: "hermetic" });

          expect(process.env.HOME).toBe(testEnv.tempHome);
          expect(process.env.XDG_CACHE_HOME).toBe(path.join(testEnv.tempHome, ".cache"));
          expect(process.env.XDG_RUNTIME_DIR).toBe(path.join(testEnv.tempHome, ".runtime"));
          expect(process.env.COREPACK_HOME).toBe(expected);
          setTestEnvValue("COREPACK_HOME", path.join(testEnv.tempHome, "changed-tool-cache"));
          testEnv.cleanup();
          expect(changedEnvKeys(callerEnv)).toEqual([]);
          expect(fs.existsSync(testEnv.tempHome)).toBe(false);
        },
      );
    },
  );

  it.each([
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_SMS_FROM",
    "TWILIO_MESSAGING_SERVICE_SID",
  ])("isolates and restores the SMS activation variable %s", (key) => {
    setTestEnvValue(key, "test-channel-value");

    const testEnv = install({ mode: "hermetic" });

    expect(process.env[key]).toBeUndefined();
    testEnv.cleanup();
    expect(process.env[key]).toBe("test-channel-value");
  });

  it.each(["live-aware", "hermetic"] as const)(
    "clears counted Git config together and restores it in non-live %s mode",
    (mode) => {
      const gitConfig = {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "http.https://config-fixture.invalid/.extraheader",
        GIT_CONFIG_VALUE_0: "Authorization: Bearer synthetic-fixture-token",
        GIT_CONFIG_KEY_1: "openclaw.fixture",
        GIT_CONFIG_VALUE_1: "caller-value",
        GIT_CONFIG_KEY_19: "openclaw.unused",
        GIT_CONFIG_VALUE_19: "",
      };
      withEnv(
        {
          LIVE: undefined,
          OPENCLAW_LIVE_TEST: undefined,
          OPENCLAW_LIVE_GATEWAY: undefined,
          ...gitConfig,
          FAL_KEY: "fal-sentinel-not-a-real-key-0123456789",
          OPENAI_API_KEY: "synthetic-provider-key",
        },
        () => {
          const callerEnv = { ...process.env };
          const testEnv = install({ mode });
          const git = spawnSync(
            "git",
            ["-c", "openclaw.isolated=active", "config", "--get", "openclaw.isolated"],
            { encoding: "utf8" },
          );
          expect(git.status, git.stderr).toBe(0);
          expect(git.stdout.trim()).toBe("active");
          expectEnvAbsent([...Object.keys(gitConfig), "OPENAI_API_KEY", "FAL_KEY"]);
          testEnv.cleanup();
          expect(changedEnvKeys(callerEnv)).toEqual([]);
        },
      );
    },
  );

  it.each(["live-aware", "hermetic"] as const)(
    "isolates and restores inherited supervisor identity in %s mode",
    (mode) => {
      const supervisorEnv = {
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
        LAUNCH_JOB_NAME: "ai.openclaw.gateway",
        XPC_SERVICE_NAME: "ai.openclaw.gateway",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "test-invocation",
        SYSTEMD_EXEC_PID: "1234",
        JOURNAL_STREAM: "8:1234",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway",
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_WRAPPER: "/fixture/operator-wrapper",
        OPENCLAW_GATEWAY_SERVICE_PID: "4321",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "FIXTURE_AUTH_REF",
        OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
      };
      setEnv(supervisorEnv);
      setTestEnvValue("TEST_UNRELATED_SERVICE_HINT", "preserved");

      const testEnv = install({ mode });

      expect(isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway")).toBe(false);
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(detectGatewayRespawnSupervisor(process.env, platform)).toBeNull();
      }
      expectEnvAbsent(Object.keys(supervisorEnv));
      expect(process.env.TEST_UNRELATED_SERVICE_HINT).toBe("preserved");
      withEnv({ XPC_SERVICE_NAME: "ai.openclaw.gateway" }, () => {
        expect(isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway")).toBe(true);
      });
      withEnv({ XPC_SERVICE_NAME: "0" }, () => {
        expect(isCurrentProcessLaunchdServiceLabel("ai.openclaw.gateway")).toBe(false);
      });

      testEnv.cleanup();
      for (const [key, value] of Object.entries(supervisorEnv)) {
        expect(process.env[key]).toBe(value);
      }
    },
  );

  it("does not load ~/.profile for normal isolated test runs", () => {
    const realHome = useProfileHome(Object.fromEntries(liveFlags.map((key) => [key, undefined])));
    const testEnv = install();

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBeUndefined();
  });

  it("falls back to parsing ~/.profile when bash is unavailable", async () => {
    const realHome = useProfileHome(liveHome);

    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw Object.assign(new Error("bash missing"), { code: "ENOENT" });
      },
    }));

    const { installTestEnv: installFreshTestEnv } = await importFreshModule<
      typeof import("./test-env.js")
    >(import.meta.url, "./test-env.js?scope=profile-fallback");

    const testEnv = installFreshTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
  });
});
