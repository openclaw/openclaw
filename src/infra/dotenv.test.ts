import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCliDotEnv } from "../cli/dotenv.js";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { loadGlobalRuntimeDotEnvFiles } from "./dotenv-global.js";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));

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
  "ComSpec",
  "LocalAppData",
  "ProgramFiles",
  "ProgramW6432",
  "SystemRoot",
  "windir",
].flatMap((key) => [key, key.toUpperCase()]);

function envContents(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

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

let base: string;
let cwdDir: string;
let stateDir: string;
let envSnapshot: ReturnType<typeof captureFullEnv>;
beforeEach(async () => {
  envSnapshot = captureFullEnv();
  base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
  cwdDir = path.join(base, "cwd");
  stateDir = path.join(base, "state");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  await fs.mkdir(cwdDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
  clearEnv(["FOO", "BAR"]);
});
afterEach(() => {
  vi.restoreAllMocks();
  envSnapshot.restore();
});

async function expectBlockedWorkspaceEnv(directory: string, lines: readonly string[]) {
  const keys = lines.map((line) => line.split("=")[0] ?? "");
  await writeEnvFile(path.join(directory, ".env"), lines.join("\n"));
  clearEnv(keys);
  loadWorkspaceDotEnvFile(path.join(directory, ".env"));
  expectEnvUndefined(keys);
}

describe("loadDotEnv", () => {
  it.each([
    ["CWD", "from-cwd"],
    ["shell", "from-shell"],
  ])("keeps %s precedence over the global fallback", async (source, expected) => {
    await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\nBAR=1\n");
    await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");
    if (source === "shell") {
      process.env.FOO = "from-shell";
    }
    loadDotEnv();
    expect(process.env).toMatchObject({ FOO: expected, BAR: "1" });
  });

  it("lets the state dotenv replace only explicitly service-managed inherited values", async () => {
    const stateEnvPath = path.join(stateDir, ".env");
    await writeEnvFile(stateEnvPath, "MANAGED_API_KEY=from-state\nOPERATOR_API_KEY=from-state\n");
    process.env.MANAGED_API_KEY = "stale-service-value";
    process.env.OPERATOR_API_KEY = "operator-service-value";

    const loaded = loadGlobalRuntimeDotEnvFiles({
      stateEnvPath,
      overrideKeys: ["MANAGED_API_KEY"],
    });

    expect(process.env.MANAGED_API_KEY).toBe("from-state");
    expect(process.env.OPERATOR_API_KEY).toBe("operator-service-value");
    expect(loaded.dotenvPresentKeys).toEqual(["MANAGED_API_KEY", "OPERATOR_API_KEY"]);
  });

  it("loads global env when the working directory was deleted", async () => {
    await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });
    loadDotEnv();

    expect(process.env.FOO).toBe("from-global");
  });

  it("loads the Ubuntu gateway.env compatibility fallback after ~/.openclaw/.env", async () => {
    setTestEnvValue("HOME", base);
    const defaultStateDir = path.join(base, ".openclaw");
    setTestEnvValue("OPENCLAW_STATE_DIR", defaultStateDir);
    await writeEnvFile(path.join(defaultStateDir, ".env"), "FOO=from-global\n");
    await writeEnvFile(
      path.join(base, ".config", "openclaw", "gateway.env"),
      ["FOO=from-gateway", "BAR=from-gateway"].join("\n"),
    );

    loggerMocks.warn.mockClear();

    loadDotEnv();

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

  it("blocks credential and gateway auth vars from CWD .env", async () => {
    await expectBlockedWorkspaceEnv(
      cwdDir,
      CREDENTIAL_AND_GATEWAY_ENV_KEYS.map((key) => `${key}=attacker-${key}`),
    );
  });

  it("blocks Windows shell trust-root vars from workspace .env", async () => {
    await expectBlockedWorkspaceEnv(
      cwdDir,
      WINDOWS_SHELL_TRUST_ROOT_ENV_KEYS.map((key) => `${key}=./evil-${key}`),
    );
  });

  it("blocks path-override vars from workspace .env", async () => {
    const bundledPluginsDir = path.join(base, "attacker-bundled");
    await expectBlockedWorkspaceEnv(cwdDir, [
      `NPM_CONFIG_PREFIX=${path.join(cwdDir, ".npm-prefix")}`,
      "OPENCLAW_AGENT_DIR=./evil-agent",
      `OPENCLAW_BUNDLED_PLUGINS_DIR=${bundledPluginsDir}`,
      "OPENCLAW_OAUTH_DIR=./evil-oauth",
      "PI_CODING_AGENT_DIR=./evil-pi-agent",
      `PNPM_HOME=${path.join(cwdDir, ".pnpm")}`,
    ]);
  });

  it("blocks lowercase npm_execpath from workspace .env", async () => {
    await expectBlockedWorkspaceEnv(cwdDir, ["npm_execpath=./evil/npm-cli.js"]);
  });

  it("still allows trusted global .env to set non-workspace runtime vars", async () => {
    const trusted = {
      ANTHROPIC_BASE_URL: "https://trusted.example.com/v1",
      HTTP_PROXY: "http://proxy.test:8080",
      OPENCLAW_PINNED_PYTHON: "/trusted/python",
      OPENCLAW_PINNED_WRITE_PYTHON: "/trusted/write-python",
      SLACK_API_URL: "http://trusted-slack.example.com/api/",
      ZALO_API_URL: "http://trusted-zalo.example.com/",
    };
    await writeEnvFile(path.join(stateDir, ".env"), envContents(trusted));
    clearEnv(Object.keys(trusted));
    loadDotEnv();
    expect(process.env).toMatchObject(trusted);
  });
});

describe("loadCliDotEnv", () => {
  it("blocks OPENCLAW_STATE_DIR from workspace .env even when unset in process env", async () => {
    await writeEnvFile(path.join(cwdDir, ".env"), "OPENCLAW_STATE_DIR=./evil-state\n");

    // Exercise the blocklist rather than the already-set skip.
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    loadCliDotEnv();

    expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
  });

  it("blocks bundled trust-root vars from workspace .env during CLI startup", async () => {
    await writeEnvFile(path.join(cwdDir, ".env"), [...BUNDLED_TRUST_ROOT_ENV_LINES].join("\n"));

    clearEnv(BUNDLED_TRUST_ROOT_ENV_KEYS);
    loadCliDotEnv();

    expectEnvUndefined(BUNDLED_TRUST_ROOT_ENV_KEYS);
  });

  it("blocks workspace .env takeover vars before loading the global fallback", async () => {
    const blocked = {
      OPENCLAW_CONFIG_PATH: "./evil-config.json",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(base, "attacker-bundled"),
      NODE_OPTIONS: "--require ./evil.js",
      NODE_REDIRECT_WARNINGS: "./warnings.log",
      NODE_REPL_EXTERNAL_MODULE: "./evil-repl.js",
      NODE_REPL_HISTORY: "./repl-history",
      NODE_V8_COVERAGE: "./coverage",
      ANTHROPIC_BASE_URL: "https://evil.example.com/v1",
      UV_PYTHON: "./attacker-python",
      uv_python: "./attacker-python-lower",
    };
    await writeEnvFile(
      path.join(cwdDir, ".env"),
      envContents({ SAFE_KEY: "from-cwd", OPENCLAW_STATE_DIR: "./evil-state", ...blocked }),
    );
    await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");
    clearEnv(["SAFE_KEY", "BAR", ...Object.keys(blocked)]);

    loadCliDotEnv();

    expect(process.env).toMatchObject({
      SAFE_KEY: "from-cwd",
      BAR: "from-global",
      OPENCLAW_STATE_DIR: stateDir,
    });
    expectEnvUndefined(Object.keys(blocked));
  });
});
