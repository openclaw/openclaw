// Qualification of the package Codex harness public audit inspection boundary.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../packages/gateway-protocol/src/schema/audit-run.js";
import { inspectCodexAudit } from "../../scripts/e2e/lib/codex-npm-plugin-live/audit-inspection.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT =
  "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs";
const auditTempDirs = useAutoCleanupTempDirTracker(afterEach);

function nodeOptionsWithoutExperimentalWarnings(): string {
  return [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"]
    .filter(Boolean)
    .join(" ");
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCodexNpmPluginLiveConfigure(root: string, auditIdentity = "0") {
  return spawnSync(process.execPath, [CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT, "configure"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CODEX_NPM_PLUGIN_AUDIT_IDENTITY: auditIdentity,
    },
  });
}

function codexAuditFixture() {
  const domainRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
  const selectors = [1, 2, 3].map((index) => ({
    runId: `codex-run-${index}`,
    executionId: `codex-execution-${index}`,
    contextId: `codex-context-${index}`,
  }));
  const replies = new Map<string, AuditRunInspectResult>();
  for (const selector of selectors) {
    const result: AuditRunInspectResult = {
      schemaVersion: 1,
      run: { runId: selector.runId, executionId: selector.executionId, status: "known" },
      identity: {
        state: "present",
        context: {
          schemaVersion: 1,
          ...selector,
          createdAt: 100,
          trustDomain: {
            kind: "gateway-cell",
            domainRef,
            state: "present",
          },
          invoker: { state: "absent" },
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          agentPrincipal: {
            kind: "agent",
            domainRef,
            principalRef: "main",
          },
          agentDefinition: { definitionRef: "main", state: "present" },
          runtimeInstance: {
            kind: "plugin-harness",
            runtimeRef: `hmac-sha256:v1:${"a".repeat(32)}:${"c".repeat(64)}`,
            state: "present",
          },
          applicableGrants: [],
          assurance: [
            {
              kind: "runtime-binding",
              evidenceRef: `hmac-sha256:v1:${"a".repeat(32)}:${"d".repeat(64)}`,
              strength: "boundary-verified",
            },
          ],
          coverageState: "unattributed",
          missingEvidence: ["invoker.principal"],
        },
      },
      decisionDisplays: [
        {
          schemaVersion: 1,
          selectorId: `${selector.contextId}:admission`,
          occurredAt: 100,
          action: { family: "run", operation: "admission" },
          decision: {
            outcome: "not-applicable",
            reasonCode: "run_admission_identity_not_evaluated",
          },
          enforcement: {
            coverageState: "unattributed",
            grantCount: 0,
            policyCount: 0,
            contextFieldsUsed: [],
          },
          provenance: { state: "verified", producer: "run-admission" },
          missingEvidence: ["invoker.principal"],
          remediation: [],
        },
      ],
      coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
    };
    replies.set(`--run ${selector.runId} --explain --limit 50`, structuredClone(result));
    replies.set(`--execution ${selector.executionId} --explain --limit 100`, result);
  }
  return { selectors, replies };
}

describe("Codex package audit qualification", () => {
  it.each([
    "missing-context",
    "wrong-run",
    "wrong-execution",
    "wrong-context",
    "fallback-runtime",
    "raw-runtime-reference",
    "invented-invoker",
    "missing-admission",
    "invented-enforcement",
    "private-reply",
    "raw-receipts",
    "truncated-decisions",
    "missing-turn",
  ])("rejects %s from the public audit inspector", (failure) => {
    const fixture = codexAuditFixture();
    const exact = fixture.replies.get("--execution codex-execution-1 --explain --limit 100");
    if (!exact || exact.identity.state !== "present") {
      throw new Error("expected exact fixture identity");
    }
    switch (failure) {
      case "missing-context":
        exact.identity = {
          state: "unsupported",
          reasonCode: "identity_context_unavailable",
          missingEvidence: ["identity.context"],
          remediation: [],
        };
        break;
      case "wrong-run":
        exact.identity.context.runId = "another-run";
        break;
      case "wrong-execution":
        exact.identity.context.executionId = "another-execution";
        break;
      case "wrong-context":
        exact.identity.context.contextId = "another-context";
        break;
      case "fallback-runtime":
        exact.identity.context.runtimeInstance.kind = "embedded";
        break;
      case "raw-runtime-reference":
        exact.identity.context.runtimeInstance.runtimeRef = "hmac-sha256:v1:private-runtime";
        break;
      case "invented-invoker":
        exact.identity.context.invoker = {
          state: "present",
          principal: { kind: "person", principalRef: "someone", domainRef: "domain" },
        };
        break;
      case "missing-admission":
        exact.decisionDisplays = [];
        break;
      case "invented-enforcement":
        exact.decisionDisplays[0]!.enforcement.coverageState = "enforced";
        break;
      case "private-reply":
        exact.decisionDisplays[0]!.action.summary = "PRIVATE_REPLY_MARKER";
        break;
      case "raw-receipts":
        Object.assign(exact, { decisions: [] });
        break;
      case "truncated-decisions":
        exact.nextDecisionCursor = "a:1:1";
        break;
      case "missing-turn":
        fixture.selectors.pop();
        break;
    }
    expect(() =>
      inspectCodexAudit({
        selectors: fixture.selectors,
        expectedExecutions: 3,
        privateValues: ["PRIVATE_REPLY_MARKER"],
        query: (args: string[]) => fixture.replies.get(args.join(" ")),
      }),
    ).toThrow();
  });
});

describe("Codex audit package CLI boundary", () => {
  it("enables audit identity only in the opted-in package fixture and queries the public CLI", () => {
    const root = auditTempDirs.make("openclaw-codex-audit-");
    const defaultConfig = runCodexNpmPluginLiveConfigure(root);
    expect(defaultConfig.status, defaultConfig.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(root, "state", "openclaw.json"), "utf8")),
    ).not.toHaveProperty("logging.audit.executionIdentity");
    const configured = runCodexNpmPluginLiveConfigure(root, "1");
    expect(configured.status, configured.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(root, "state", "openclaw.json"), "utf8")),
    ).toMatchObject({
      logging: { audit: { enabled: true, executionIdentity: true } },
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token" } },
    });
    const fixture = codexAuditFixture();
    const databasePath = path.join(root, "state", "state", "openclaw.sqlite");
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE execution_identity_contexts (run_id TEXT, execution_id TEXT, context_id TEXT, created_at INTEGER)",
      );
      const insert = database.prepare(
        "INSERT INTO execution_identity_contexts VALUES (?, ?, ?, ?)",
      );
      fixture.selectors.forEach((selector, index) =>
        insert.run(selector.runId, selector.executionId, selector.contextId, index),
      );
    } finally {
      database.close();
    }
    writeJson(path.join(root, "replies.json"), Object.fromEntries(fixture.replies));
    const cliPath = path.join(root, "openclaw-fixture.cjs");
    writeFileSync(
      cliPath,
      `const fs = require("node:fs");
const path = require("node:path");
const [command, ...args] = process.argv.slice(2);
if (command !== "audit" || args.pop() !== "--json") process.exit(2);
const replies = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"));
const reply = replies[args.join(" ")];
if (!reply) process.exit(3);
fs.appendFileSync(path.join(__dirname, "queries.jsonl"), JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify(reply));\n`,
    );
    const result = spawnSync(
      process.execPath,
      [CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_SCRIPT, "assert-audit", "PRIVATE_REPLY_MARKER"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(root, "home"),
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_E2E_CLI_BIN: cliPath,
          NODE_OPTIONS: nodeOptionsWithoutExperimentalWarnings(),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('codex_audit_identity: {"executionCount":3}');
    expect(
      readFileSync(path.join(root, "queries.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      fixture.selectors.flatMap((selector) => [
        ["--run", selector.runId, "--explain", "--limit", "50"],
        ["--execution", selector.executionId, "--explain", "--limit", "100"],
      ]),
    );
  });
});
