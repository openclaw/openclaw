// Codex npm plugin live assertion tests cover bounded diagnostics and transcript scans.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs";
const DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";

const tempDirs: string[] = [];

function nodeOptionsWithoutExperimentalWarnings(extra?: string): string {
  const current = [process.env.NODE_OPTIONS, extra].filter(Boolean).join(" ");
  return current.includes(DISABLE_EXPERIMENTAL_WARNING)
    ? current
    : [current, DISABLE_EXPERIMENTAL_WARNING].filter(Boolean).join(" ");
}

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-codex-npm-plugin-live-"));
  tempDirs.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertion(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      ...env,
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(env.NODE_OPTIONS),
    },
  });
}

function writeSuccessfulAgentTurnFixture(root: string, marker: string, threadId: string): void {
  const stateDir = path.join(root, "state");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const sessionFile = path.join(sessionsDir, "openclaw-session.jsonl");
  const agentDbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(sessionFile, "{}\n", "utf8");
  mkdirSync(path.dirname(agentDbPath), { recursive: true });
  const db = new DatabaseSync(agentDbPath);
  try {
    db.exec(
      "CREATE TABLE cache_entries (scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO cache_entries(scope, key, value_json) VALUES (?, ?, ?)").run(
      "session_entries",
      "local",
      JSON.stringify({
        agentHarnessId: "codex",
        sessionFile,
        sessionId: "codex-npm-plugin-live",
      }),
    );
  } finally {
    db.close();
  }
  writeJson(`${sessionFile}.codex-app-server.json`, {
    model: "gpt-5.4",
    schemaVersion: 1,
    threadId,
  });

  const codexSessionDir = path.join(
    stateDir,
    "agents",
    "main",
    "codex-home",
    "sessions",
    "2026",
    "06",
    "06",
  );
  mkdirSync(codexSessionDir, { recursive: true });
  writeFileSync(
    path.join(codexSessionDir, `rollout-2026-06-06T00-00-00-${threadId}.jsonl`),
    `${"x".repeat(1024 * 1024 + 10)}${marker}\n`,
    "utf8",
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("codex npm plugin live assertions", () => {
  it("streams native Codex transcript evidence across scan chunks", () => {
    const root = makeRoot();
    const marker = "OPENCLAW-CODEX-NPM-PLUGIN-LIVE-OK";
    const threadId = "019eac09-6a0a-7000-8000-000000000001";
    const agentOutputPath = path.join(root, "agent.json");
    const agentErrorPath = path.join(root, "agent.err");
    writeJson(agentOutputPath, {
      meta: { executionTrace: { winnerProvider: "codex" } },
      payloads: [{ text: marker }],
    });
    writeFileSync(agentErrorPath, "", "utf8");
    writeSuccessfulAgentTurnFixture(root, marker, threadId);

    const result = runAssertion(
      root,
      ["assert-agent-turn", marker, "codex-npm-plugin-live", "codex/gpt-5.4"],
      {
        OPENCLAW_CODEX_NPM_PLUGIN_AGENT_ERROR_PATH: agentErrorPath,
        OPENCLAW_CODEX_NPM_PLUGIN_AGENT_OUTPUT_PATH: agentOutputPath,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("bounds agent reply diagnostics when the marker is missing", () => {
    const root = makeRoot();
    const agentOutputPath = path.join(root, "agent.json");
    const agentErrorPath = path.join(root, "agent.err");
    writeJson(agentOutputPath, {
      meta: { executionTrace: { winnerProvider: "codex" } },
      payloads: [{ text: `DO_NOT_DUMP_OLD_STDOUT${"x".repeat(70 * 1024)}recent stdout tail` }],
    });
    writeFileSync(
      agentErrorPath,
      `DO_NOT_DUMP_OLD_STDERR${"x".repeat(70 * 1024)}recent stderr tail\n`,
      "utf8",
    );

    const result = runAssertion(
      root,
      ["assert-agent-turn", "MISSING-MARKER", "codex-npm-plugin-live", "codex/gpt-5.4"],
      {
        OPENCLAW_CODEX_NPM_PLUGIN_AGENT_ERROR_PATH: agentErrorPath,
        OPENCLAW_CODEX_NPM_PLUGIN_AGENT_OUTPUT_PATH: agentOutputPath,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stdout tail=");
    expect(result.stderr).toContain("stderr tail=");
    expect(result.stderr).toContain("recent stdout tail");
    expect(result.stderr).toContain("recent stderr tail");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_STDOUT");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_STDERR");
  });

  it("bounds post-uninstall agent error diagnostics", () => {
    const root = makeRoot();
    const agentOutputPath = path.join(root, "agent-after-uninstall.json");
    const agentErrorPath = path.join(root, "agent-after-uninstall.err");
    writeFileSync(
      agentOutputPath,
      `DO_NOT_DUMP_OLD_AFTER_STDOUT${"x".repeat(70 * 1024)}recent after stdout tail\n`,
      "utf8",
    );
    writeFileSync(
      agentErrorPath,
      `DO_NOT_DUMP_OLD_AFTER_STDERR${"x".repeat(70 * 1024)}recent after stderr tail\n`,
      "utf8",
    );

    const result = runAssertion(root, ["assert-agent-error", "1"], {
      OPENCLAW_CODEX_NPM_PLUGIN_AGENT_AFTER_UNINSTALL_ERROR_PATH: agentErrorPath,
      OPENCLAW_CODEX_NPM_PLUGIN_AGENT_AFTER_UNINSTALL_OUTPUT_PATH: agentOutputPath,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stdout tail=");
    expect(result.stderr).toContain("stderr tail=");
    expect(result.stderr).toContain("recent after stdout tail");
    expect(result.stderr).toContain("recent after stderr tail");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_AFTER_STDOUT");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_AFTER_STDERR");
  });
});
