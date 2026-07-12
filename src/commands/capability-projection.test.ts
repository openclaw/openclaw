import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { collectExactTurnFromTrajectory } from "./capability-projection-collectors.js";
import type { CapabilityName, EvidenceState, ToolFact } from "./capability-projection-model.js";
import {
  assertCapabilityProjectionParity,
  publishCapabilityProjectionPair,
  renderCapabilityProjectionJson,
  renderCapabilityProjectionMarkdown,
} from "./capability-projection-render.js";
import { capabilityProjectionReportJsonSchema } from "./capability-projection-schema.js";
import {
  buildCapabilityProjectionReport,
  capabilityProjectionCommand,
  type CapabilityProjectionInput,
} from "./capability-projection.js";

const tempDirs: string[] = [];
const now = "2026-07-12T16:00:00.000Z";
const sessionKey = "agent:main:discord:channel:synthetic";
const runId = "run-synthetic";

function direct(value: EvidenceState["value"], ref: string): EvidenceState {
  return { value, basis: "direct", evidenceRefs: [ref] };
}

function fact(
  capability: CapabilityName,
  name: string,
  options: Partial<Omit<ToolFact, "capability" | "name">> = {},
): ToolFact {
  return {
    capability,
    name,
    mutationRisk: "read_only",
    configured: direct("true", "config"),
    runtimeLoaded: direct("true", "runtime"),
    policyAllowed: direct("true", "policy"),
    turnProjected: direct("unknown", "placeholder"),
    ...options,
  };
}

const PLUGIN_ID_BY_CAPABILITY = {
  goal_tools: "hooks",
  workboard: "workboard",
  llm_task: "llm-task",
  task_flow: "task-flow",
  commitments: "commitments",
  hooks: "hooks",
  browser: "browser",
  memory: "memory",
  messaging: "messaging",
  shell_execution: "shell-execution",
  readiness_health: "readiness-health",
} as const;

function evidenceFromFacts(facts: ToolFact[]): CapabilityProjectionInput["evidence"] {
  return facts.flatMap((item) => {
    const suffix = `${item.capability}-${item.name}`;
    const configured =
      item.configured.value === "true" ? true : item.configured.value === "false" ? false : null;
    const loaded =
      item.runtimeLoaded.value === "true"
        ? true
        : item.runtimeLoaded.value === "false"
          ? false
          : null;
    const allowed = item.policyAllowed.value === "true" ? [item.name] : [];
    const denied = item.policyAllowed.value === "false" ? [item.name] : [];
    const records: CapabilityProjectionInput["evidence"] = [
      {
        id: `config-${suffix}`,
        rank: 6,
        kind: "raw_config",
        source: "sanitized fixture",
        observedAt: now,
        periodRelation: "same_period",
        status: "collected",
        fields: {
          capability: item.capability,
          configured,
          enabled: item.capability === "goal_tools" ? null : configured,
        },
        redactionApplied: true,
      },
      {
        id: `runtime-${suffix}`,
        rank: 3,
        kind: "plugin_runtime",
        source: "sanitized fixture",
        observedAt: now,
        periodRelation: "same_period",
        status: "collected",
        fields: {
          pluginId: PLUGIN_ID_BY_CAPABILITY[item.capability],
          enabled: loaded,
          loaded,
          toolNames: [item.name],
          hookNames: [],
        },
        redactionApplied: true,
      },
      {
        id: `policy-${suffix}`,
        rank: 4,
        kind: "effective_policy",
        source: "sanitized fixture",
        observedAt: now,
        periodRelation: "same_period",
        status: "collected",
        fields: {
          profile: "fixture",
          allowedToolNames: allowed,
          deniedToolNames: denied,
          sandboxMode: "fixture",
        },
        redactionApplied: true,
      },
    ];
    if (item.derivedRegistryLoaded) {
      records.push({
        id: `registry-${suffix}`,
        rank: 7,
        kind: "derived_registry",
        source: "sanitized fixture",
        observedAt: now,
        periodRelation: "same_period",
        status: "collected",
        fields: { registryId: item.capability, toolNames: [item.name], hookNames: [] },
        redactionApplied: true,
      });
    }
    if (item.selfReportedCallable) {
      records.push({
        id: `self-report-${suffix}`,
        rank: 8,
        kind: "agent_self_report",
        source: "sanitized fixture",
        observedAt: now,
        periodRelation: "same_period",
        status: "collected",
        fields: { claimCode: "CALLABLE", toolNames: [item.name] },
        redactionApplied: true,
      });
    }
    return records;
  });
}

function input(params: {
  facts: ToolFact[];
  tools?: string[];
  successful?: string[];
  missing?: boolean;
  evidence?: CapabilityProjectionInput["evidence"];
  observations?: CapabilityProjectionInput["observations"];
  errors?: CapabilityProjectionInput["collectionErrors"];
}): CapabilityProjectionInput {
  return {
    generatedAt: now,
    host: {
      hostname: "fixture-host",
      user: "fixture-user",
      uid: 1000,
      instanceDir: "/fixture/instance",
      workspaceDir: "/fixture/workspace",
    },
    openclawVersion: "fixture-version",
    agentId: "main",
    sessionKey,
    evidenceWindow: { start: "2026-07-12T15:59:00.000Z", end: "2026-07-12T16:01:00.000Z" },
    selection: { mode: "exact_run_id", runId },
    trajectory: params.missing
      ? { compiled: null, successfulToolResults: [], errorCode: "MISSING_SESSION_PROJECTION" }
      : {
          compiled: {
            ts: now,
            seq: 7,
            sessionId: "session-synthetic",
            sessionKey,
            runId,
            toolNames: [...(params.tools ?? [])],
          },
          successfulToolResults: (params.successful ?? []).map((toolName) => ({
            ts: now,
            runId,
            toolName,
            success: true as const,
          })),
        },
    evidence: [...evidenceFromFacts(params.facts), ...(params.evidence ?? [])],
    observations: params.observations,
    collectionErrors: params.errors,
  };
}

function tool(
  report: ReturnType<typeof buildCapabilityProjectionReport>,
  capability: CapabilityName,
  name: string,
) {
  const record = report.capabilities
    .find((item) => item.name === capability)
    ?.tools.find((item) => item.name === name);
  if (!record) {
    throw new Error(`missing fixture tool ${capability}/${name}`);
  }
  return record;
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capability-projection-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("capability projection acceptance fixtures", () => {
  it("reproduces Workboard loaded but not allowed or projected", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [
          fact("workboard", "workboard_create", {
            policyAllowed: direct("false", "policy"),
            mutationRisk: "mutating",
          }),
        ],
      }),
    );
    const record = tool(report, "workboard", "workboard_create");
    expect(record.runtimeLoaded.value).toBe("true");
    expect(record.policyAllowed.value).toBe("false");
    expect(record.turnProjected.value).toBe("false");
    expect(record.mismatchCodes).toContain("LOADED_NOT_POLICY_ALLOWED");
  });

  it("derives historical acceptance facts from sanitized evidence only", () => {
    const report = buildCapabilityProjectionReport({
      ...input({ facts: [] }),
      evidence: [
        {
          id: "workboard-runtime",
          rank: 3,
          kind: "plugin_runtime",
          source: "sanitized fixture",
          observedAt: now,
          periodRelation: "same_period",
          status: "collected",
          fields: {
            pluginId: "workboard",
            enabled: true,
            loaded: true,
            toolNames: ["workboard_list"],
            hookNames: [],
          },
          redactionApplied: true,
        },
        {
          id: "policy",
          rank: 4,
          kind: "effective_policy",
          source: "sanitized fixture",
          observedAt: now,
          periodRelation: "same_period",
          status: "collected",
          fields: {
            profile: "fixture",
            allowedToolNames: ["memory_get"],
            deniedToolNames: ["workboard_list", "create_goal", "get_goal", "update_goal"],
            sandboxMode: "fixture",
          },
          redactionApplied: true,
        },
        {
          id: "llm-task-runtime",
          rank: 3,
          kind: "plugin_runtime",
          source: "sanitized fixture",
          observedAt: now,
          periodRelation: "same_period",
          status: "collected",
          fields: {
            pluginId: "llm-task",
            enabled: false,
            loaded: false,
            toolNames: ["llm_task"],
            hookNames: [],
          },
          redactionApplied: true,
        },
        {
          id: "llm-task-config",
          rank: 6,
          kind: "raw_config",
          source: "sanitized fixture",
          observedAt: now,
          periodRelation: "same_period",
          status: "collected",
          fields: { capability: "llm_task", configured: false, enabled: false },
          redactionApplied: true,
        },
      ],
    });
    expect(tool(report, "workboard", "workboard_list").runtimeLoaded.value).toBe("true");
    expect(tool(report, "workboard", "workboard_list").policyAllowed.value).toBe("false");
    expect(tool(report, "goal_tools", "get_goal").policyAllowed.value).toBe("false");
    expect(tool(report, "llm_task", "llm_task").configured.value).toBe("false");
    expect(tool(report, "llm_task", "llm_task").callabilityStatus).toBe("disabled");
  });

  it("does not combine current, historical, or failed evidence with the selected period", () => {
    const report = buildCapabilityProjectionReport({
      ...input({ facts: [] }),
      evidence: [
        {
          id: "stale-policy",
          rank: 4,
          kind: "effective_policy",
          source: "sanitized fixture",
          periodRelation: "same_period",
          status: "collected",
          observedAt: "2026-07-11T16:00:00.000Z",
          fields: {
            profile: "fixture",
            allowedToolNames: ["memory_get"],
            deniedToolNames: [],
            sandboxMode: "fixture",
          },
          redactionApplied: true,
        },
        {
          id: "failed-runtime",
          rank: 3,
          kind: "plugin_runtime",
          source: "sanitized fixture",
          observedAt: now,
          periodRelation: "same_period",
          status: "failed",
          fields: {
            pluginId: "memory",
            enabled: true,
            loaded: true,
            toolNames: ["memory_get"],
            hookNames: [],
          },
          redactionApplied: true,
        },
      ],
    });
    const record = tool(report, "memory", "memory_get");
    expect(record.policyAllowed.value).toBe("unknown");
    expect(record.runtimeLoaded.value).toBe("unknown");
    expect(record.mismatchCodes).toContain("EVIDENCE_PERIOD_MISMATCH");
    expect(report.overallConfidence.level).toBe("medium");
    expect(report.overallConfidence.reasonCodes).toContain("EVIDENCE_COLLECTION_FAILED");
  });

  it("reports absent goal tools without probing them", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [
          fact("goal_tools", "get_goal", {
            configured: direct("false", "config"),
            runtimeLoaded: direct("false", "runtime"),
            policyAllowed: direct("false", "policy"),
          }),
        ],
      }),
    );
    expect(tool(report, "goal_tools", "get_goal").callabilityStatus).toBe("not_projected");
  });

  it("reports LLM Task disabled", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [
          fact("llm_task", "llm_task", {
            configured: direct("false", "config"),
            runtimeLoaded: direct("false", "runtime"),
            policyAllowed: direct("false", "policy"),
            disabled: true,
          }),
        ],
      }),
    );
    expect(tool(report, "llm_task", "llm_task").callabilityStatus).toBe("disabled");
  });

  it("verifies an existing successful read-only call", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [fact("memory", "memory_get")],
        tools: ["memory_get"],
        successful: ["memory_get"],
      }),
    );
    expect(tool(report, "memory", "memory_get").callabilityStatus).toBe(
      "verified_callable_read_only",
    );
  });

  it("does not probe a projected mutating tool", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [fact("messaging", "message", { mutationRisk: "mutating" })],
        tools: ["message"],
      }),
    );
    expect(tool(report, "messaging", "message").callabilityStatus).toBe(
      "projected_but_not_safely_probed",
    );
  });

  it("detects stale derived registry evidence", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [
          fact("hooks", "hook_tool", {
            runtimeLoaded: direct("false", "runtime"),
            derivedRegistryLoaded: true,
          }),
        ],
      }),
    );
    expect(tool(report, "hooks", "hook_tool").mismatchCodes).toContain("DERIVED_REGISTRY_STALE");
  });

  it("keeps current healthy and historical failure evidence separate", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [fact("readiness_health", "gateway_health")],
        observations: [
          {
            code: "CURRENT_HEALTHY",
            period: "current",
            severity: "info",
            summary: "Current sanitized probe passed.",
            evidenceRefs: ["health-current"],
          },
          {
            code: "HISTORICAL_CURRENT_STATE_DIFFERENCE",
            period: "historical",
            severity: "watch",
            summary: "A historical sanitized probe failed.",
            evidenceRefs: ["health-history"],
          },
        ],
      }),
    );
    expect(report.observations.map((item) => item.period)).toEqual(["current", "historical"]);
  });

  it("turns collection failure into unknown rather than false", () => {
    const report = buildCapabilityProjectionReport(
      input({ facts: [fact("browser", "browser")], missing: true }),
    );
    expect(tool(report, "browser", "browser").turnProjected.value).toBe("unknown");
    expect(report.overallConfidence.level).toBe("low");
  });

  it("excludes secret-bearing source data by construction", () => {
    const report = buildCapabilityProjectionReport(
      input({ facts: [fact("memory", "memory_search")], tools: ["memory_search"] }),
    );
    const outputs = `${renderCapabilityProjectionJson(report)}${renderCapabilityProjectionMarkdown(report)}`;
    for (const forbidden of [
      "Bearer secret",
      "cookie=session-secret",
      "BEGIN PRIVATE KEY",
      "systemPrompt",
      "private message",
      "tool result secret",
      "sk-test-secret",
    ]) {
      expect(outputs.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(() =>
      buildCapabilityProjectionReport({
        ...input({ facts: [] }),
        evidence: [
          {
            id: "unsafe",
            rank: 8,
            kind: "agent_self_report",
            source: "sanitized fixture",
            observedAt: now,
            periodRelation: "same_period",
            status: "collected",
            fields: { claimCode: "token=fixture-secret", toolNames: ["memory_get"] },
            redactionApplied: false,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      buildCapabilityProjectionReport({
        ...input({ facts: [] }),
        evidence: [
          {
            id: "unsafe-bare-credential",
            rank: 8,
            kind: "agent_self_report",
            source: "sanitized fixture",
            observedAt: now,
            periodRelation: "same_period",
            status: "collected",
            fields: { claimCode: "sk-proj-abcdefghijklmnop", toolNames: ["memory_get"] },
            redactionApplied: false,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      buildCapabilityProjectionReport({
        ...input({ facts: [] }),
        observations: [
          {
            code: "UNSAFE_OBSERVATION",
            period: "current",
            severity: "watch",
            summary: "authorization: Bearer fixture-secret",
            evidenceRefs: ["fixture"],
          },
        ],
      }),
    ).toThrow("prohibited secret-bearing value");
  });

  it("renders JSON and Markdown from the same normalized record", () => {
    const report = buildCapabilityProjectionReport(
      input({ facts: [fact("browser", "browser")], tools: ["browser"] }),
    );
    const markdown = renderCapabilityProjectionMarkdown(report);
    expect(() => assertCapabilityProjectionParity(report, markdown)).not.toThrow();
    expect(JSON.parse(renderCapabilityProjectionJson(report)).reportId).toBe(report.reportId);
  });

  it("blocks exact-turn conclusions when session projection is missing", () => {
    const report = buildCapabilityProjectionReport(
      input({ facts: [fact("shell_execution", "exec")], missing: true }),
    );
    expect(report.target.selectionMode).toBe("unresolved");
    expect(report.collectionErrors.map((error) => error.code)).toContain(
      "MISSING_SESSION_PROJECTION",
    );
  });

  it("retains partial plugin inspection as a safe evidence gap", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [
          fact("workboard", "workboard_list", {
            runtimeLoaded: {
              value: "unknown",
              basis: "none",
              evidenceRefs: [],
              reasonCode: "PARTIAL_PLUGIN_INSPECTION",
            },
          }),
        ],
        errors: [
          {
            collector: "plugin-runtime",
            code: "PARTIAL_PLUGIN_INSPECTION",
            message: "raw unsafe stderr",
            occurredAt: now,
            affectedClaims: ["workboard.runtimeLoaded"],
          },
        ],
      }),
    );
    expect(tool(report, "workboard", "workboard_list").runtimeLoaded.value).toBe("unknown");
    expect(renderCapabilityProjectionJson(report)).not.toContain("raw unsafe stderr");
  });

  it("reports policy allowed but not projected", () => {
    const report = buildCapabilityProjectionReport(
      input({ facts: [fact("memory", "memory_get")] }),
    );
    expect(tool(report, "memory", "memory_get").mismatchCodes).toContain(
      "POLICY_ALLOWED_NOT_PROJECTED",
    );
  });

  it("reports projection and policy conflict", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [fact("browser", "browser", { policyAllowed: direct("false", "policy") })],
        tools: ["browser"],
      }),
    );
    expect(tool(report, "browser", "browser").mismatchCodes).toContain(
      "PROJECTED_NOT_POLICY_ALLOWED",
    );
  });

  it("produces the same report ID under reordered evidence", () => {
    const facts = [fact("memory", "memory_search"), fact("memory", "memory_get")];
    const first = buildCapabilityProjectionReport(
      input({ facts, tools: ["memory_search", "memory_get"] }),
    );
    const second = buildCapabilityProjectionReport(
      input({ facts: [...facts].reverse(), tools: ["memory_get", "memory_search"] }),
    );
    expect(second.reportId).toBe(first.reportId);
  });

  it("does not use successful shell evidence from another run", async () => {
    const dir = await makeTempDir();
    const trajectory = path.join(dir, "fixture.trajectory.jsonl");
    const events = [
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "t",
        source: "runtime",
        type: "tool.result",
        ts: now,
        seq: 0,
        sessionId: "s",
        sessionKey,
        runId,
        data: { name: "exec", success: true },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "t",
        source: "runtime",
        type: "context.compiled",
        ts: now,
        seq: 1,
        sessionId: "s",
        sessionKey,
        runId,
        data: {
          tools: [{ name: "exec", description: "discard me", parameters: { secret: true } }],
          prompt: "discard me",
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "t",
        source: "runtime",
        type: "tool.result",
        ts: "2026-07-12T16:00:00.500Z",
        seq: 2,
        sessionId: "s",
        sessionKey,
        runId,
        data: { name: "exec", success: true },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "t",
        source: "runtime",
        type: "tool.result",
        ts: now,
        seq: 2,
        sessionId: "s",
        sessionKey,
        runId: "other-run",
        data: { name: "exec", success: true, result: "discard me" },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "t",
        source: "runtime",
        type: "tool.result",
        ts: now,
        seq: 2,
        sessionId: "other-session",
        sessionKey: "agent:main:discord:channel:other",
        runId,
        data: { name: "exec", success: true },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "t",
        source: "runtime",
        type: "context.compiled",
        ts: "2026-07-12T16:00:01.000Z",
        seq: 3,
        sessionId: "s",
        sessionKey,
        runId,
        data: { tools: [{ name: "exec" }] },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "t",
        source: "runtime",
        type: "tool.result",
        ts: "2026-07-12T16:00:02.000Z",
        seq: 4,
        sessionId: "s",
        sessionKey,
        runId,
        data: { name: "exec", success: true },
      },
    ];
    await fs.writeFile(trajectory, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const collected = await collectExactTurnFromTrajectory(
      trajectory,
      {
        mode: "exact_event_sequence",
        sequence: 1,
      },
      {
        sessionId: "s",
        sessionKey,
        evidenceWindow: { start: "2026-07-12T15:59:00Z", end: now },
      },
    );
    expect(collected.compiled?.toolNames).toEqual(["exec"]);
    expect(collected.successfulToolResults).toEqual([]);
    expect(JSON.stringify(collected)).not.toContain("discard me");
    const wrongSession = await collectExactTurnFromTrajectory(
      trajectory,
      { mode: "exact_event_sequence", sequence: 1 },
      {
        sessionId: "other-session",
        sessionKey,
        evidenceWindow: { start: "2026-07-12T15:59:00Z", end: "2026-07-12T16:01:00Z" },
      },
    );
    expect(wrongSession.errorCode).toBe("MISSING_SESSION_PROJECTION");
  });

  it("does not treat readiness observability as autonomy", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [fact("readiness_health", "readiness_canary")],
        tools: ["readiness_canary"],
        observations: [
          {
            code: "READINESS_OBSERVABILITY_ONLY",
            period: "current",
            severity: "info",
            summary: "Observability only; no recovery or autonomy action.",
            evidenceRefs: ["canary"],
          },
        ],
      }),
    );
    expect(report.capabilities.map((item) => item.name)).not.toContain("autonomy");
    expect(report.observations[0]?.code).toBe("READINESS_OBSERVABILITY_ONLY");
  });

  it("does not promote uncorroborated agent self-report", () => {
    const report = buildCapabilityProjectionReport(
      input({
        facts: [
          fact("goal_tools", "create_goal", {
            configured: direct("false", "config"),
            runtimeLoaded: direct("false", "runtime"),
            policyAllowed: direct("false", "policy"),
            mutationRisk: "mutating",
            selfReportedCallable: true,
          }),
        ],
      }),
    );
    expect(tool(report, "goal_tools", "create_goal").mismatchCodes).toContain(
      "SELF_REPORT_UNCORROBORATED",
    );
  });
});

describe("collector and publication safety", () => {
  it("rejects unredacted CLI evidence and conflicting session ownership", async () => {
    const dir = await makeTempDir();
    const evidenceFile = path.join(dir, "evidence.json");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;
    await fs.writeFile(
      evidenceFile,
      JSON.stringify([
        {
          id: "unsafe",
          rank: 8,
          kind: "agent_self_report",
          source: "sanitized fixture",
          observedAt: now,
          periodRelation: "same_period",
          status: "collected",
          fields: { claimCode: "CALLABLE", toolNames: ["memory_get"] },
          redactionApplied: false,
        },
      ]),
    );
    await capabilityProjectionCommand(
      {
        sessionKey,
        runId,
        windowStart: "2026-07-12T15:59:00Z",
        windowEnd: "2026-07-12T16:01:00Z",
        evidenceFile,
        outputRoot: dir,
      },
      runtime,
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "Capability projection evidence file is invalid or unreadable.",
    );
    vi.clearAllMocks();
    await fs.writeFile(evidenceFile, "[]");
    await capabilityProjectionCommand(
      {
        sessionKey,
        agent: "other",
        runId,
        windowStart: "2026-07-12T15:59:00Z",
        windowEnd: "2026-07-12T16:01:00Z",
        evidenceFile,
        outputRoot: dir,
      },
      runtime,
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "Capability projection --agent conflicts with the canonical session owner.",
    );
  });

  it("has a closed evidence schema with no arbitrary evidence fields", () => {
    const schemaText = JSON.stringify(capabilityProjectionReportJsonSchema);
    expect(schemaText).toContain("context_compiled");
    expect(schemaText).toContain("additionalProperties");
    expect(schemaText).not.toContain('"fields":{}');
  });

  it("requires explicit bounds for latest-in-window through its closed selection type", async () => {
    const dir = await makeTempDir();
    const trajectory = path.join(dir, "fixture.jsonl");
    await fs.writeFile(trajectory, "");
    const result = await collectExactTurnFromTrajectory(
      trajectory,
      {
        mode: "latest_in_window",
        start: "2026-07-12T00:00:00Z",
        end: "2026-07-12T01:00:00Z",
      },
      {
        sessionId: "fixture",
        sessionKey,
        evidenceWindow: { start: "2026-07-12T00:00:00Z", end: "2026-07-12T01:00:00Z" },
      },
    );
    expect(result.errorCode).toBe("MISSING_SESSION_PROJECTION");
    const invalid = await collectExactTurnFromTrajectory(
      trajectory,
      {
        mode: "latest_in_window",
        start: "not-a-date",
        end: "2026-07-12T01:00:00Z",
      },
      {
        sessionId: "fixture",
        sessionKey,
        evidenceWindow: { start: "2026-07-12T00:00:00Z", end: "2026-07-12T01:00:00Z" },
      },
    );
    expect(invalid.errorCode).toBe("EVIDENCE_COLLECTION_FAILED");
    const reversed = await collectExactTurnFromTrajectory(
      trajectory,
      {
        mode: "latest_in_window",
        start: "2026-07-12T02:00:00Z",
        end: "2026-07-12T01:00:00Z",
      },
      {
        sessionId: "fixture",
        sessionKey,
        evidenceWindow: { start: "2026-07-12T00:00:00Z", end: "2026-07-12T03:00:00Z" },
      },
    );
    expect(reversed.errorCode).toBe("EVIDENCE_COLLECTION_FAILED");
  });

  it("publishes mode-0600 files only under the approved root", async () => {
    const root = await makeTempDir();
    const report = buildCapabilityProjectionReport(
      input({ facts: [fact("browser", "browser")], tools: ["browser"] }),
    );
    const result = await publishCapabilityProjectionPair({
      report,
      outputRoot: root,
      outputDir: path.join(root, "reports"),
    });
    expect((await fs.stat(result.jsonPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(result.markdownPath)).mode & 0o777).toBe(0o600);
    await expect(
      publishCapabilityProjectionPair({
        report,
        outputRoot: root,
        outputDir: path.join(root, "..", "escape"),
      }),
    ).rejects.toThrow("escaped");
    const outside = await makeTempDir();
    await fs.symlink(outside, path.join(root, "linked"));
    await expect(
      publishCapabilityProjectionPair({
        report,
        outputRoot: root,
        outputDir: path.join(root, "linked", "reports"),
      }),
    ).rejects.toThrow("non-directory");
    await expect(
      publishCapabilityProjectionPair({
        report,
        outputRoot: root,
        outputDir: path.join(root, "windows"),
        platform: "win32",
      }),
    ).rejects.toThrow("supported on Linux only");
    await expect(
      publishCapabilityProjectionPair({
        report,
        outputRoot: root,
        outputDir: path.join(root, "darwin"),
        platform: "darwin",
      }),
    ).rejects.toThrow("supported on Linux only");
    const versionsOutside = await makeTempDir();
    const versionsOutput = path.join(root, "versions-link");
    await fs.mkdir(versionsOutput);
    await fs.symlink(versionsOutside, path.join(versionsOutput, ".versions"));
    await expect(
      publishCapabilityProjectionPair({
        report,
        outputRoot: root,
        outputDir: versionsOutput,
        platform: "linux",
      }),
    ).rejects.toThrow("not a real directory");
    const symlinkRootTarget = await makeTempDir();
    const symlinkRootParent = await makeTempDir();
    const symlinkRoot = path.join(symlinkRootParent, "root-link");
    await fs.symlink(symlinkRootTarget, symlinkRoot);
    await expect(
      publishCapabilityProjectionPair({
        report,
        outputRoot: symlinkRoot,
        outputDir: path.join(symlinkRoot, "reports"),
        platform: "linux",
      }),
    ).rejects.toThrow("root is not a real directory");
    const hostileCurrentOutput = path.join(root, "hostile-current");
    await fs.mkdir(hostileCurrentOutput);
    await fs.symlink(versionsOutside, path.join(hostileCurrentOutput, ".current"));
    await expect(
      publishCapabilityProjectionPair({
        report,
        outputRoot: root,
        outputDir: hostileCurrentOutput,
        platform: "linux",
      }),
    ).rejects.toThrow("unexpected target");
  });

  it("preserves the previous complete pair when publication fails", async () => {
    const root = await makeTempDir();
    const outputDir = path.join(root, "reports");
    const report = buildCapabilityProjectionReport(
      input({ facts: [fact("browser", "browser")], tools: ["browser"] }),
    );
    await publishCapabilityProjectionPair({ report, outputRoot: root, outputDir });
    const oldJson = await fs.readFile(path.join(outputDir, "current-turn.json"), "utf8");
    const oldMarkdown = await fs.readFile(path.join(outputDir, "current-turn.md"), "utf8");
    const nextReport = buildCapabilityProjectionReport({
      ...input({ facts: [fact("browser", "browser")], tools: ["browser"] }),
      generatedAt: "2026-07-12T16:01:00.000Z",
    });
    const fsImpl = {
      chmod: fs.chmod,
      lstat: fs.lstat,
      mkdir: fs.mkdir,
      readFile: fs.readFile,
      readlink: fs.readlink,
      realpath: fs.realpath,
      rm: fs.rm,
      symlink: fs.symlink,
      writeFile: fs.writeFile,
      rename: vi.fn(async (from: string, to: string) => {
        if (to.endsWith(".current")) {
          throw new Error("fixture publication failure");
        }
        await fs.rename(from, to);
      }),
    };
    await expect(
      publishCapabilityProjectionPair({ report: nextReport, outputRoot: root, outputDir, fsImpl }),
    ).rejects.toThrow("fixture publication failure");
    expect(await fs.readFile(path.join(outputDir, "current-turn.json"), "utf8")).toBe(oldJson);
    expect(await fs.readFile(path.join(outputDir, "current-turn.md"), "utf8")).toBe(oldMarkdown);
  });

  it("exposes no generic tool invocation or mutation callback", async () => {
    const source = await fs.readFile(
      new URL("./capability-projection-collectors.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/invokeTool|executeTool|sendMessage|mutate|restart|spawn/u);
    expect(source).not.toContain("/home/admin/.openclaw");
  });
});
