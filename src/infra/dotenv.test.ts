// Tests dotenv file loading and environment merge behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { loadCliDotEnv } from "../cli/dotenv.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { loadGlobalRuntimeDotEnvFiles } from "./dotenv-global.js";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => loggerMocks),
}));

const CREDENTIAL_AND_GATEWAY_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_SECONDARY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENAI_API_KEY_SECONDARY",
  "OPENCLAW_LIVE_ANTHROPIC_KEY",
  "OPENCLAW_LIVE_ANTHROPIC_KEYS",
  "OPENCLAW_LIVE_GEMINI_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_SECRET",
] as const;

const BUNDLED_TRUST_ROOT_ENV_LINES = [
  "OPENCLAW_BROWSER_CONTROL_MODULE=data:text/javascript,boom",
  "OPENCLAW_BUNDLED_HOOKS_DIR=./attacker-hooks",
  "OPENCLAW_BUNDLED_PLUGINS_DIR=./attacker-plugins",
  "OPENCLAW_BUNDLED_SKILLS_DIR=./attacker-skills",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1",
] as const;

const BUNDLED_TRUST_ROOT_ENV_KEYS = BUNDLED_TRUST_ROOT_ENV_LINES.map(
  (line) => line.split("=")[0] ?? "",
);

const WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS = [
  "AppData",
  "APPDATA",
  "ComSpec",
  "COMSPEC",
  "LocalAppData",
  "LOCALAPPDATA",
  "ProgramFiles",
  "PROGRAMFILES",
  "ProgramW6432",
  "PROGRAMW6432",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
] as const;

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

function clearEnv(keys: readonly string[]) {
  for (const key of keys) {
    deleteTestEnvValue(key);
  }
}

function expectEnvUndefined(keys: readonly string[]) {
  for (const key of keys) {
    expect(process.env[key]).toBeUndefined();
  }
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const envSnapshot = captureFullEnv();
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
    envSnapshot.restore();
  }
}

type DotEnvFixture = {
  base: string;
  cwdDir: string;
  stateDir: string;
};

async function withDotEnvFixture(run: (fixture: DotEnvFixture) => Promise<void>) {
  await withIsolatedEnvAndCwd(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
    const cwdDir = path.join(base, "cwd");
    const stateDir = path.join(base, "state");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await run({ base, cwdDir, stateDir });
  });
}

describe("loadDotEnv", () => {
  it("loads ~/.openclaw/.env as fallback without overriding CWD .env", async () => {
    await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
      await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\nBAR=1\n");
      await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      delete process.env.FOO;
      delete process.env.BAR;

      loadDotEnv({ quiet: true });

      expect(process.env.FOO).toBe("from-cwd");
      expect(process.env.BAR).toBe("1");
    });
  });

  it("does not override an already-set env var from the shell", async () => {
    await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
      process.env.FOO = "from-shell";

      await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
      await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

      loadDotEnv({ quiet: true });

      expect(process.env.FOO).toBe("from-shell");
    });
  });

  it("lets the state dotenv replace only explicitly service-managed inherited values", async () => {
    await withDotEnvFixture(async ({ stateDir }) => {
      const stateEnvPath = path.join(stateDir, ".env");
      await writeEnvFile(stateEnvPath, "MANAGED_API_KEY=from-state\nOPERATOR_API_KEY=from-state\n");
      process.env.MANAGED_API_KEY = "stale-service-value";
      process.env.OPERATOR_API_KEY = "operator-service-value";

      const loaded = loadGlobalRuntimeDotEnvFiles({
        stateEnvPath,
        overrideKeys: ["MANAGED_API_KEY"],
        quiet: true,
      });

      expect(process.env.MANAGED_API_KEY).toBe("from-state");
      expect(process.env.OPERATOR_API_KEY).toBe("operator-service-value");
      expect(loaded.dotenvPresentKeys).toEqual(["MANAGED_API_KEY", "OPERATOR_API_KEY"]);
    });
  });

  it("loads global env when the working directory was deleted", async () => {
    await withDotEnvFixture(async ({ stateDir }) => {
      await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
      vi.spyOn(process, "cwd").mockImplementation(() => {
        throw new Error("ENOENT: uv_cwd");
      });
      delete process.env.FOO;

      loadDotEnv({ quiet: true });

      expect(process.env.FOO).toBe("from-global");
    });
  });

  it("loads the Ubuntu gateway.env compatibility fallback after ~/.openclaw/.env", async () => {
    await withDotEnvFixture(async ({ base, cwdDir }) => {
      setTestEnvValue("HOME", base);
      const defaultStateDir = path.join(base, ".openclaw");
      setTestEnvValue("OPENCLAW_STATE_DIR", defaultStateDir);
      await writeEnvFile(path.join(defaultStateDir, ".env"), "FOO=from-global\n");
      await writeEnvFile(
        path.join(base, ".config", "openclaw", "gateway.env"),
        ["FOO=from-gateway", "BAR=from-gateway"].join("\n"),
      );

      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      delete process.env.FOO;
      delete process.env.BAR;
      loggerMocks.warn.mockClear();

      loadDotEnv({ quiet: true });

      expect(process.env.FOO).toBe("from-global");
      expect(process.env.BAR).toBe("from-gateway");
      expect(loggerMocks.warn).toHaveBeenCalledOnce();
      const [message, metadata] = expectDefined(
        loggerMocks.warn.mock.calls[0],
        "logger warning call",
      );
      expect(String(message)).toContain("Conflicting values in");
      expect(String((metadata as { ignoredPath?: unknown } | undefined)?.ignoredPath)).toContain(
        "gateway.env",
      );
    });
  });

  it("blocks credential and gateway auth vars from CWD .env", async () => {
    await withDotEnvFixture(async ({ cwdDir }) => {
      await writeEnvFile(
        path.join(cwdDir, ".env"),
        CREDENTIAL_AND_GATEWAY_ENV_KEYS.map((key) => `${key}=attacker-${key}`).join("\n"),
      );

      clearEnv(CREDENTIAL_AND_GATEWAY_ENV_KEYS);

      loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

      expectEnvUndefined(CREDENTIAL_AND_GATEWAY_ENV_KEYS);
    });
  });

  it("blocks Windows shell trust-root vars from workspace .env", async () => {
    await withDotEnvFixture(async ({ cwdDir }) => {
      await writeEnvFile(
        path.join(cwdDir, ".env"),
        WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS.map((key) => `${key}=./evil-${key}`).join("\n"),
      );

      clearEnv(WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS);

      loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

      expectEnvUndefined(WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS);
    });
  });

  it("blocks path-override vars from workspace .env", async () => {
    await withDotEnvFixture(async ({ base, cwdDir }) => {
      const bundledPluginsDir = path.join(base, "attacker-bundled");
      const pathOverrideEnvKeys = [
        "NPM_CONFIG_PREFIX",
        "OPENCLAW_AGENT_DIR",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
        "OPENCLAW_OAUTH_DIR",
        "PI_CODING_AGENT_DIR",
        "PNPM_HOME",
      ] as const;
      await writeEnvFile(
        path.join(cwdDir, ".env"),
        [
          `NPM_CONFIG_PREFIX=${path.join(cwdDir, ".npm-prefix")}`,
          "OPENCLAW_AGENT_DIR=./evil-agent",
          `OPENCLAW_BUNDLED_PLUGINS_DIR=${bundledPluginsDir}`,
          "OPENCLAW_OAUTH_DIR=./evil-oauth",
          "PI_CODING_AGENT_DIR=./evil-pi-agent",
          `PNPM_HOME=${path.join(cwdDir, ".pnpm")}`,
        ].join("\n"),
      );

      clearEnv(pathOverrideEnvKeys);

      loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

      expectEnvUndefined(pathOverrideEnvKeys);
    });
  });

  it("blocks lowercase npm_execpath from workspace .env", async () => {
    const key = "npm_execpath";
    await withDotEnvFixture(async ({ cwdDir }) => {
      await writeEnvFile(path.join(cwdDir, ".env"), `${key}=./evil/npm-cli.js\n`);

      deleteTestEnvValue(key);

      loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

      expect(process.env[key]).toBeUndefined();
    });
  });

  it("still allows trusted global .env to set non-workspace runtime vars", async () => {
    await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
      await writeEnvFile(
        path.join(stateDir, ".env"),
        [
          "ANTHROPIC_BASE_URL=https://trusted.example.com/v1",
          "HTTP_PROXY=http://proxy.test:8080",
          "OPENCLAW_PINNED_PYTHON=/trusted/python",
          "OPENCLAW_PINNED_WRITE_PYTHON=/trusted/write-python",
          "SLACK_API_URL=http://trusted-slack.example.com/api/",
          "ZALO_API_URL=http://trusted-zalo.example.com/",
        ].join("\n"),
      );
      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.HTTP_PROXY;
      delete process.env.OPENCLAW_PINNED_PYTHON;
      delete process.env.OPENCLAW_PINNED_WRITE_PYTHON;
      delete process.env.SLACK_API_URL;
      delete process.env.ZALO_API_URL;

      loadDotEnv({ quiet: true });

      expect(process.env.ANTHROPIC_BASE_URL).toBe("https://trusted.example.com/v1");
      expect(process.env.HTTP_PROXY).toBe("http://proxy.test:8080");
      expect(process.env.OPENCLAW_PINNED_PYTHON).toBe("/trusted/python");
      expect(process.env.OPENCLAW_PINNED_WRITE_PYTHON).toBe("/trusted/write-python");
      expect(process.env.SLACK_API_URL).toBe("http://trusted-slack.example.com/api/");
      expect(process.env.ZALO_API_URL).toBe("http://trusted-zalo.example.com/");
    });
  });
});

describe("loadCliDotEnv", () => {
  it("blocks OPENCLAW_STATE_DIR from workspace .env even when unset in process env", async () => {
    await withDotEnvFixture(async ({ cwdDir }) => {
      await writeEnvFile(path.join(cwdDir, ".env"), "OPENCLAW_STATE_DIR=./evil-state\n");

      // Delete the fixture-provided value so the blocking must come from
      // the workspace blocklist, not the "already set" skip.
      deleteTestEnvValue("OPENCLAW_STATE_DIR");
      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

      loadCliDotEnv({ quiet: true });

      expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
    });
  });

  it("blocks bundled trust-root vars from workspace .env during CLI startup", async () => {
    await withDotEnvFixture(async ({ cwdDir }) => {
      await writeEnvFile(path.join(cwdDir, ".env"), [...BUNDLED_TRUST_ROOT_ENV_LINES].join("\n"));

      clearEnv(BUNDLED_TRUST_ROOT_ENV_KEYS);
      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

      loadCliDotEnv({ quiet: true });

      expectEnvUndefined(BUNDLED_TRUST_ROOT_ENV_KEYS);
    });
  });

  it("blocks workspace .env takeover vars before loading the global fallback", async () => {
    await withDotEnvFixture(async ({ base, cwdDir, stateDir }) => {
      const bundledPluginsDir = path.join(base, "attacker-bundled");
      await writeEnvFile(
        path.join(cwdDir, ".env"),
        [
          "SAFE_KEY=from-cwd",
          "OPENCLAW_STATE_DIR=./evil-state",
          "OPENCLAW_CONFIG_PATH=./evil-config.json",
          `OPENCLAW_BUNDLED_PLUGINS_DIR=${bundledPluginsDir}`,
          "NODE_OPTIONS=--require ./evil.js",
          "NODE_REDIRECT_WARNINGS=./warnings.log",
          "NODE_REPL_EXTERNAL_MODULE=./evil-repl.js",
          "NODE_REPL_HISTORY=./repl-history",
          "NODE_V8_COVERAGE=./coverage",
          "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
          "UV_PYTHON=./attacker-python",
          "uv_python=./attacker-python-lower",
        ].join("\n"),
      );
      await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

      vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
      delete process.env.SAFE_KEY;
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      delete process.env.NODE_OPTIONS;
      delete process.env.NODE_REDIRECT_WARNINGS;
      delete process.env.NODE_REPL_EXTERNAL_MODULE;
      delete process.env.NODE_REPL_HISTORY;
      delete process.env.NODE_V8_COVERAGE;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.UV_PYTHON;
      delete process.env.uv_python;
      delete process.env.BAR;

      loadCliDotEnv({ quiet: true });

      expect(process.env.SAFE_KEY).toBe("from-cwd");
      expect(process.env.BAR).toBe("from-global");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
      expect(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR).toBeUndefined();
      expect(process.env.NODE_OPTIONS).toBeUndefined();
      expect(process.env.NODE_REDIRECT_WARNINGS).toBeUndefined();
      expect(process.env.NODE_REPL_EXTERNAL_MODULE).toBeUndefined();
      expect(process.env.NODE_REPL_HISTORY).toBeUndefined();
      expect(process.env.NODE_V8_COVERAGE).toBeUndefined();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.UV_PYTHON).toBeUndefined();
      expect(process.env.uv_python).toBeUndefined();
    });
  });
});
