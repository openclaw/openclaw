import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  emitAgentAuditEvent,
  onAgentAuditEvent,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { buildRuntimeSkillSelectionMarker } from "../skills/runtime-skill-selection.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import { listAuditEvents, recordAuditEventInDatabase } from "./audit-event-store.js";
import type { AuditEventInput, SkillSelectionAuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";

const tempDirs: string[] = [];

function createDatabaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-audit-skill-") } };
}

function auditInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  const input = {
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  } as AuditEventInput;
}

function skillSelectionInput(
  overrides: Partial<SkillSelectionAuditEventInput> = {},
): SkillSelectionAuditEventInput {
  const input: SkillSelectionAuditEventInput = {
    sourceId: "skill-selection:2",
    sourceSequence: 2,
    occurredAt: Date.now(),
    kind: "skill_selection",
    action: "skill.selection.observed",
    status: "observed",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    toolName: "debug-toolkit",
    ...overrides,
  };
  return {
    ...input,
    sourceId:
      overrides.sourceId ??
      `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
  };
}

function agentEvent(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-hidden-skill",
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    data: { phase: "start" },
    sessionKey: "agent:coder:main",
    sessionId: "session-1",
    agentId: "coder",
    ...overrides,
  };
}

function captureAuditWriter(inputs: AuditEventInput[]): AuditEventWriter {
  return {
    ready: Promise.resolve(),
    record: (input) => {
      inputs.push(input);
      return true;
    },
    recordExecutionIdentity: () => true,
    recordExecutionDecision: () => true,
    recordExecutionDecisionWork: () => true,
    stop: async () => {},
  };
}

function projectAgentEventToAudit(event: AgentEventPayload): AuditEventInput | undefined {
  const inputs: AuditEventInput[] = [];
  const recorder = createAgentEventAuditRecorder({
    writer: captureAuditWriter(inputs),
    getConfig: () => ({}),
    terminalSettleMs: 60_000,
  });
  recorder.record(event);
  void recorder.stop();
  return inputs.at(-1);
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetAgentEventsForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("hidden-run skill-selection audit attribution", () => {
  it("keeps skill-selection session attribution after hidden-run top-level redaction", () => {
    const projected = projectAgentEventToAudit(
      agentEvent({
        stream: "skill_selection",
        sessionKey: undefined,
        sessionId: undefined,
        data: {
          kind: "skill_selection",
          selectedSkill: "debug-toolkit",
          selectionSource: "observed_runtime",
          selectionConfidence: "observed",
          selectionRule: "tool_invocation",
          redaction: "metadata_only",
          agentId: "coder",
          sessionKey: "agent:hidden:main",
          sessionId: "session-hidden",
        },
      }),
    );

    expect(projected).toMatchObject({
      kind: "skill_selection",
      action: "skill.selection.observed",
      agentId: "coder",
      sessionKey: "agent:hidden:main",
      sessionId: "session-hidden",
      toolName: "debug-toolkit",
    });
  });

  it("adds the skill-selection companion table on an existing audit database", async () => {
    const database = createDatabaseOptions();
    recordAuditEventInDatabase(auditInput(), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    const { db } = openOpenClawStateDatabase(database);
    db.exec("DROP TABLE IF EXISTS audit_skill_selection_events");
    closeOpenClawStateDatabaseForTest();

    const skill = recordAuditEventInDatabase(skillSelectionInput(), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    expect(skill).toMatchObject({
      kind: "skill_selection",
      sessionKey: "agent:main:main",
      toolName: "debug-toolkit",
    });
    expect(
      (
        await listAuditEvents({
          database,
          limit: 10,
          filters: { kind: "skill_selection", sessionKey: "agent:main:main" },
        })
      ).events,
    ).toEqual([
      expect.objectContaining({ kind: "skill_selection", sessionKey: "agent:main:main" }),
    ]);
    expect(
      (await listAuditEvents({ database, limit: 10 })).events.map((event) => event.kind),
    ).toEqual(["agent_run"]);
  });

  it("persists hidden-run skill selection for session-filtered readback", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:hidden:main";
    registerAgentRunContext("run-hidden-skill", {
      sessionKey,
      sessionId: "session-hidden",
      agentId: "coder",
      isControlUiVisible: false,
    });
    const inputs: AuditEventInput[] = [];
    const recorder = createAgentEventAuditRecorder({
      writer: captureAuditWriter(inputs),
      getConfig: () => ({}),
      terminalSettleMs: 60_000,
    });
    const stopAudit = onAgentAuditEvent(recorder.record);
    let publicSkillSelection = false;
    const stopPublic = onAgentEvent((event) => {
      if (event.stream === "skill_selection") {
        publicSkillSelection = true;
      }
    });

    emitAgentAuditEvent({
      runId: "run-hidden-skill",
      stream: "skill_selection",
      agentId: "coder",
      sessionKey,
      sessionId: "session-hidden",
      data: buildRuntimeSkillSelectionMarker({
        agentId: "coder",
        sessionKey,
        sessionId: "session-hidden",
        runId: "run-hidden-skill",
        skillName: "debug-toolkit",
        skillSource: "workspace",
        activation: "read",
      }),
    });
    stopAudit();
    stopPublic();
    await recorder.stop();

    expect(publicSkillSelection).toBe(false);
    expect(inputs).toEqual([
      expect.objectContaining({
        kind: "skill_selection",
        sessionKey,
        sessionId: "session-hidden",
        toolName: "debug-toolkit",
      }),
    ]);
    expect(
      recordAuditEventInDatabase(inputs[0]!, {
        ...database,
        database: openOpenClawStateDatabase(database),
      }),
    ).toMatchObject({
      kind: "skill_selection",
      sessionKey,
    });
    expect(
      (
        await listAuditEvents({
          database,
          limit: 10,
          filters: { kind: "skill_selection", sessionKey },
        })
      ).events,
    ).toEqual([
      expect.objectContaining({
        kind: "skill_selection",
        sessionKey,
        sessionId: "session-hidden",
        toolName: "debug-toolkit",
      }),
    ]);
  });
});
