import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/release-scenarios/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";
const directories = useAutoCleanupTempDirTracker(afterEach);
const fixture = () => directories.make("openclaw-release-scenarios-");
const envRef = {
  type: "api_key",
  provider: "openai",
  keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
};

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(args: string[], env?: NodeJS.ProcessEnv) {
  const current = process.env.NODE_OPTIONS ?? "";
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: current.includes(DISABLE_EXPERIMENTAL_WARNING)
        ? current
        : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" "),
    },
  });
}

function authAssertion(profile: unknown, config: Record<string, unknown> = {}) {
  const home = path.join(fixture(), "home");
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  writeJson(configPath, {
    auth: { profiles: { "openai:api-key": { provider: "openai", mode: "api_key" } } },
    ...config,
  });
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE IF NOT EXISTS config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES (?, ?, ?)
      `,
    ).run(
      "authProfiles.store",
      JSON.stringify({ version: 1, profiles: { "openai:api-key": profile } }),
      Date.now(),
    );
  } finally {
    db.close();
  }
  const result = runAssertion(["assert-openai-env-ref", "sk-test-raw-key"], {
    HOME: home,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  });
  return { result, stateDir };
}

function imageAssertion(kind: "describe" | "generate") {
  const root = fixture();
  const outputPath = path.join(root, `${kind}.json`);
  const requestLogPath = path.join(root, "requests.jsonl");
  const imagePath = path.join(root, "generated.png");
  if (kind === "generate") {
    writeFileSync(imagePath, "png", "utf8");
  }
  writeJson(outputPath, {
    capability: `image.${kind}`,
    ok: true,
    outputs:
      kind === "describe"
        ? [{ provider: "openai", text: "OPENCLAW_E2E_OK describe" }]
        : [{ mimeType: "image/png", path: imagePath }],
    ...(kind === "generate" ? { provider: "openai" } : {}),
  });
  const prefix = kind === "describe" ? "/v1/res" : "/v1/images/gener";
  const suffix = kind === "describe" ? "ponses" : "ations";
  writeFileSync(
    requestLogPath,
    `${"x".repeat(64 * 1024 - prefix.length)}${prefix}${suffix}\n`,
    "utf8",
  );
  return runAssertion([`assert-image-${kind}`, outputPath, requestLogPath]);
}

function packageAssertion(version: string) {
  const packageRoot = path.join(fixture(), "openclaw");
  writeJson(path.join(packageRoot, "package.json"), { name: "openclaw", version });
  return runAssertion(["assert-package-version", packageRoot, "2026.5.26", "candidate"]);
}

describe("release scenario assertions", () => {
  it("reports bounded onboarding hook diagnostics without leaking unrelated config", () => {
    const configPath = path.join(fixture(), "openclaw.json");
    const secretSentinel = "release-diagnostic-secret-sentinel";
    writeJson(configPath, {
      wizard: { lastRunCommand: "onboard", lastRunMode: "local", lastRunVersion: secretSentinel },
      hooks: {
        internal: { enabled: true, entries: { "unrelated-hook": { token: secretSentinel } } },
      },
      env: { vars: { OPENCLAW_TEST_SECRET: secretSentinel } },
    });
    const result = runAssertion(["assert-session-memory-hook-enabled"], {
      OPENCLAW_CONFIG_PATH: configPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Onboarding config projection: {"wizard":{"present":true,"lastRunCommand":"onboard","lastRunMode":"local"},"hooks":{"present":true,"internalPresent":true,"internalEnabled":true,"sessionMemoryPresent":false,"sessionMemoryEnabled":"missing"}}',
    );
    expect(result.stderr).not.toContain(secretSentinel);
    expect(result.stderr.length).toBeLessThan(4 * 1024);
  });

  it.each(["describe", "generate"] as const)("scans large image %s request logs", (kind) => {
    expect(imageAssertion(kind)).toMatchObject({ status: 0, stderr: "" });
  });

  it("accepts OpenAI env refs from the SQLite auth profile store", () => {
    const { result, stateDir } = authAssertion(envRef);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(
      existsSync(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
    ).toBe(false);
  });

  it.each([
    ["missing env ref", { note: "OPENAI_API_KEY" }, {}, "OpenAI env ref was not persisted"],
    [
      "inline profile key",
      { type: "api_key", provider: "openai", key: "sk-test-raw-key" },
      {},
      "raw OpenAI key was persisted",
    ],
    [
      "inline config key",
      envRef,
      { models: { providers: { openai: { apiKey: "sk-test-raw-key" } } } },
      "raw OpenAI key was persisted",
    ],
  ] as const)("rejects %s", (_name, profile, config, message) => {
    const { result } = authAssertion(profile, config);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it("passes when the installed package version matches the candidate version", () => {
    expect(packageAssertion("2026.5.26")).toMatchObject({ status: 0, stderr: "" });
  });

  it("fails when the global install still points at the baseline version", () => {
    const result = packageAssertion("2026.5.22");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "candidate package version mismatch: expected 2026.5.26, got 2026.5.22",
    );
  });
});
