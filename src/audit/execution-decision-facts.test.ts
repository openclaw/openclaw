import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditRunInspectResultSchema,
  type ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { activityRunInspectorSearch } from "../../ui/src/pages/activity/run-inspector-model.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEventInDatabase } from "./audit-event-store.js";
import {
  pageExecutionDecisionFactsForContextInDatabase,
  pruneExpiredExecutionDecisionFactsInDatabase,
  recordExecutionDecisionFactInDatabase,
  summarizeExecutionDecisionFactsForContextInDatabase,
} from "./execution-decision-facts.js";
import {
  receipt,
  seedExecutionContext,
  tokenForContext,
  createUnattributedExecutionContext,
} from "./execution-decision-facts.test-support.js";
import { presentExecutionDecisionReceiptsInDatabase } from "./execution-decision-receipts.js";
import { createExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  ensureExecutionOwnerLifecycleBindingSchema,
} from "./execution-owner-lifecycle-binding-store.js";
import {
  configureMessageActionDecisionSink,
  recordMessageActionDecision,
} from "./message-action-decision.js";
import { recordOutboundMessageProgressInDatabase } from "./message-delivery-progress-store.js";

const noLifecycleBindings = { cronRunReceipts: true, executionOwnerLifecycleBindings: false };

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-decision-facts-") } };
}

describe("execution decision facts", () => {
  it("retains generic task and flow facts as unverified evidence after lifecycle retirement", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const opened = openOpenClawStateDatabase(database);
    for (const family of ["task", "flow"]) {
      expect(
        recordExecutionDecisionFactInDatabase(
          {
            ...receipt("historical-" + family),
            action: { family, operation: "lifecycle", summary: "private historical summary" },
          },
          { ...database, database: opened, now: 100 },
        ),
      ).toBe("inserted");
    }
    const inspection = presentExecutionDecisionReceiptsInDatabase(opened.db, {
      schema: noLifecycleBindings,
      context,
      decisionCursor: "g:0:0",
      now: 100,
    });
    // Equal timestamps are ordered by receipt identity, not insertion order.
    expect(inspection.decisions.map((decision) => decision.action.family)).toEqual([
      "flow",
      "task",
    ]);
    expect(inspection.decisionDisplays).toHaveLength(2);
    for (const display of inspection.decisionDisplays) {
      expect(display).toMatchObject({
        action: { family: "decision", operation: "record" },
        decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
        provenance: { state: "unverified" },
      });
    }
    expect(JSON.stringify(inspection.decisionDisplays)).not.toContain("private historical summary");
    expect(inspection.coverage.state).toBe("unknown");
    expect(
      opened.db.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts").get(),
    ).toEqual({ count: 2 });
  });

  it("persists repeated same-reason broadcast denials with opaque distinct ids", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    const token = createExecutionIdentityAdmissionToken("run-1", {
      contextId: "context-1",
      executionId: "execution-1",
      now: 100,
    });
    const clear = configureMessageActionDecisionSink(
      (decision) =>
        recordExecutionDecisionFactInDatabase(decision, {
          ...database,
          database: openOpenClawStateDatabase(database),
          now: 100,
        }) === "inserted",
    );
    try {
      for (const receiptDiscriminator of ["broadcast:0", "broadcast:1"]) {
        expect(
          recordMessageActionDecision({
            token,
            actionId: "broadcast-action",
            action: "broadcast",
            channel: "qa-channel",
            outcome: "denied",
            reasonCode: "message_target_unknown",
            coverageState: "enforced",
            policyRefs: ["message-target:known"],
            summary: "Message action was denied before platform delivery.",
            remediation: [],
            receiptDiscriminator,
            occurredAt: 100,
          }),
        ).toBe(true);
      }
    } finally {
      clear();
    }

    const receipts = pageExecutionDecisionFactsForContextInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: 100,
      },
    ).receipts;
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((item) => item.receiptId)).size).toBe(2);
    expect(JSON.stringify(receipts)).not.toContain("broadcast:0");
    expect(JSON.stringify(receipts)).not.toContain("broadcast:1");
  });

  it("projects owner-native outbound delivery into run inspection", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const now = Date.now();
    const storedEvent = recordAuditEventInDatabase(
      {
        sourceId: "message:outbound:queue:delivery-1:payload:0",
        sourceSequence: 1,
        occurredAt: now,
        kind: "message",
        action: "message.outbound.finished",
        status: "succeeded",
        outcome: "sent",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "run-1",
        executionIdentityToken: tokenForContext(context),
        direction: "outbound",
        channel: "qa-channel",
        conversationKind: "direct",
        resultCount: 1,
        targetId: "raw-target",
        messageId: "raw-message-id",
      },
      { ...database, database: openOpenClawStateDatabase(database) },
    );
    if (!storedEvent) {
      throw new Error("expected owner-native message event");
    }

    const inspection = presentExecutionDecisionReceiptsInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        schema: noLifecycleBindings,
        context,
        decisionLimit: 10,
        now,
      },
    );
    expect(inspection.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.objectContaining({ family: "message", operation: "send" }),
          decision: { outcome: "allowed", reasonCode: "message_delivered" },
          enforcement: expect.objectContaining({ coverageState: "attribution-only" }),
          source: expect.objectContaining({ owner: "audit_events" }),
        }),
      ]),
    );
    expect(inspection.decisionDisplays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.objectContaining({ family: "message", operation: "send" }),
          decision: { outcome: "allowed", reasonCode: "message_delivered" },
          provenance: { state: "verified", producer: "message-delivery" },
        }),
      ]),
    );
    const messageReceipt = inspection.decisions.find((item) => item.action.family === "message");
    const messageDisplay = inspection.decisionDisplays.find(
      (item) =>
        item.provenance.state === "verified" && item.provenance.producer === "message-delivery",
    );
    expect(messageDisplay?.selectorId).toBe(
      `message-decision:${2_000_000_000_000 + storedEvent.sequence}`,
    );
    expect(messageDisplay?.selectorId).not.toBe(messageReceipt?.receiptId);
    const receiptSearch = activityRunInspectorSearch(
      { kind: "run", id: context.runId },
      { id: messageDisplay?.selectorId ?? "" },
    );
    expect(new URLSearchParams(receiptSearch.slice(1)).get("receipt")).toBe(
      messageDisplay?.selectorId,
    );
    expect(receiptSearch).not.toContain(encodeURIComponent(messageReceipt?.receiptId ?? ""));
  });

  it("projects exact-bound cron owner rows without generic facts", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const db = openOpenClawStateDatabase(database).db;
    db.prepare(
      `INSERT INTO cron_run_receipts (
         receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
         status, owner_pid, started_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "cron-receipt-1",
      "default",
      "job-1",
      "revision-1",
      "main",
      context.runId,
      "ok",
      1,
      60,
      70,
    );
    ensureExecutionOwnerLifecycleBindingSchema(db);
    expect(
      bindExecutionOwnerLifecycleMetadata({
        db,
        ownerKind: "cron",
        ownerId: "cron-receipt-1",
        binding: { contextId: context.contextId, executionId: context.executionId },
      }),
    ).toBe("bound");

    const result = presentExecutionDecisionReceiptsInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        schema: { cronRunReceipts: true, executionOwnerLifecycleBindings: true },
        context,
        decisionLimit: 10,
        now: 100,
      },
    );
    expect(result.decisions.map((item) => item.source.owner)).toEqual([
      "agent-command",
      "cron_run_receipts",
    ]);
    expect(tableExists(db, "execution_decision_facts")).toBe(false);
  });

  it("does not assign run-only delivery evidence to either exact execution sharing a run id", () => {
    const database = databaseOptions();
    const first = seedExecutionContext(database, {
      runId: "shared-run",
      contextId: "context-first",
      executionId: "execution-first",
    });
    const second = seedExecutionContext(database, {
      runId: "shared-run",
      contextId: "context-second",
      executionId: "execution-second",
    });
    const now = Date.now();
    recordAuditEventInDatabase(
      {
        sourceId: "message:shared-run:unbound",
        sourceSequence: 1,
        occurredAt: now,
        kind: "message",
        action: "message.outbound.finished",
        status: "succeeded",
        outcome: "sent",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "shared-run",
        direction: "outbound",
        channel: "qa-channel",
        conversationKind: "direct",
        resultCount: 1,
      },
      { ...database, database: openOpenClawStateDatabase(database) },
    );

    for (const context of [first, second]) {
      expect(
        presentExecutionDecisionReceiptsInDatabase(openOpenClawStateDatabase(database).db, {
          schema: noLifecycleBindings,
          context,
          decisionLimit: 10,
          now,
        }).decisions.filter((item) => item.action.family === "message"),
      ).toEqual([]);
    }
    expect(
      tableExists(openOpenClawStateDatabase(database).db, "outbound_message_execution_bindings"),
    ).toBe(false);

    recordAuditEventInDatabase(
      {
        sourceId: "message:shared-run:first-execution",
        sourceSequence: 2,
        occurredAt: now + 1,
        kind: "message",
        action: "message.outbound.finished",
        status: "succeeded",
        outcome: "sent",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "shared-run",
        executionIdentityToken: tokenForContext(first),
        direction: "outbound",
        channel: "qa-channel",
        conversationKind: "direct",
        resultCount: 1,
      },
      { ...database, database: openOpenClawStateDatabase(database) },
    );
    const messageReceipts = (context: ExecutionIdentityContextV1) =>
      presentExecutionDecisionReceiptsInDatabase(openOpenClawStateDatabase(database).db, {
        schema: noLifecycleBindings,
        context,
        decisionLimit: 10,
        now: now + 1,
      }).decisions.filter((item) => item.action.family === "message");
    expect(messageReceipts(first)).toHaveLength(1);
    expect(messageReceipts(second)).toEqual([]);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare(
          "SELECT context_id, execution_id, run_id FROM outbound_message_execution_bindings",
        )
        .all(),
    ).toEqual([
      {
        context_id: "context-first",
        execution_id: "execution-first",
        run_id: "shared-run",
      },
    ]);
  });

  it("keeps delivery stages distinct, redacted, replay-safe, and retention bounded", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const now = Date.now();
    const common = {
      sourceSequence: 1,
      occurredAt: now,
      kind: "message" as const,
      actorType: "agent" as const,
      actorId: "main",
      agentId: "main",
      runId: "run-1",
      executionIdentityToken: tokenForContext(context),
      direction: "outbound" as const,
      channel: "qa-channel",
      conversationKind: "direct" as const,
      targetId: "raw-channel-target",
    };
    const events = [
      {
        ...common,
        occurredAt: now,
        sourceId: "queue-1:queued",
        action: "message.outbound.queued" as const,
        status: "started" as const,
        outcome: "queued" as const,
      },
      {
        ...common,
        occurredAt: now + 1,
        sourceId: "queue-1:platform",
        action: "message.outbound.platform-started" as const,
        status: "started" as const,
        outcome: "platform_started" as const,
      },
      {
        ...common,
        occurredAt: now + 2,
        sourceId: "queue-1:finished",
        action: "message.outbound.finished" as const,
        status: "succeeded" as const,
        outcome: "sent" as const,
        messageId: "raw-platform-message",
      },
      {
        ...common,
        occurredAt: now + 3,
        sourceId: "queue-2:failed",
        action: "message.outbound.finished" as const,
        status: "failed" as const,
        outcome: "failed" as const,
        errorCode: "message_delivery_failed" as const,
        failureStage: "queue" as const,
      },
      {
        ...common,
        occurredAt: now + 4,
        sourceId: "queue-3:failed",
        action: "message.outbound.finished" as const,
        status: "failed" as const,
        outcome: "failed" as const,
        errorCode: "message_delivery_failed" as const,
        failureStage: "platform_send" as const,
      },
      {
        ...common,
        occurredAt: now + 5,
        sourceId: "queue-4:suppressed",
        action: "message.outbound.finished" as const,
        status: "blocked" as const,
        outcome: "suppressed" as const,
        reasonCode: "no_visible_payload" as const,
      },
    ];
    for (const event of events) {
      expect(
        event.action === "message.outbound.finished"
          ? recordAuditEventInDatabase(event, {
              ...database,
              database: openOpenClawStateDatabase(database),
            })
          : recordOutboundMessageProgressInDatabase(event, {
              ...database,
              database: openOpenClawStateDatabase(database),
            }),
      ).toBeDefined();
    }
    expect(
      recordOutboundMessageProgressInDatabase(
        {
          ...common,
          occurredAt: now,
          sourceId: "queue-1:queued",
          action: "message.outbound.queued",
          status: "started",
          outcome: "queued",
        },
        { ...database, database: openOpenClawStateDatabase(database) },
      ),
    ).toBeUndefined();

    const inspect = () =>
      presentExecutionDecisionReceiptsInDatabase(openOpenClawStateDatabase(database).db, {
        schema: noLifecycleBindings,
        context,
        decisionCursor: "m:0:0",
        decisionLimit: 10,
        now,
      });
    const firstInspection = inspect();
    expect(firstInspection.decisions.map((item) => item.decision.reasonCode)).toEqual([
      "message_queued",
      "message_platform_started",
      "message_delivered",
      "message_delivery_failed_queue",
      "message_delivery_failed_platform_send",
      "message_suppressed_no_visible_payload",
    ]);
    expect(firstInspection.decisions.map((item) => item.enforcement.coverageState)).toEqual(
      Array.from({ length: 6 }, () => "attribution-only"),
    );
    expect(firstInspection.decisions.map((item) => item.source.owner)).toEqual([
      "outbound_message_progress",
      "outbound_message_progress",
      "audit_events",
      "audit_events",
      "audit_events",
      "audit_events",
    ]);
    const selectors = firstInspection.decisionDisplays.map((item) => item.selectorId);
    expect(selectors).toHaveLength(firstInspection.decisions.length);
    expect(new Set(selectors).size).toBe(selectors.length);
    expect(selectors.every((selector) => selector.startsWith("message-decision:"))).toBe(true);
    expect(JSON.stringify(firstInspection)).not.toContain("raw-channel-target");
    expect(JSON.stringify(firstInspection)).not.toContain("raw-platform-message");

    closeOpenClawStateDatabaseForTest();
    expect(inspect().decisionDisplays.map((item) => item.selectorId)).toEqual(selectors);
    expect(
      presentExecutionDecisionReceiptsInDatabase(openOpenClawStateDatabase(database).db, {
        schema: noLifecycleBindings,
        context,
        decisionCursor: "m:0:0",
        decisionLimit: 10,
        now: now + RETENTION_MS + events.length + 1,
      }).decisions,
    ).toEqual([]);
  });

  it("stays absent until a future owner writes one immutable fact", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    const opened = openOpenClawStateDatabase(database);
    expect(tableExists(opened.db, "execution_decision_facts")).toBe(false);
    expect(
      pruneExpiredExecutionDecisionFactsInDatabase({
        database: { ...database, database: openOpenClawStateDatabase(database) },
      }),
    ).toBe(0);
    expect(tableExists(opened.db, "execution_decision_facts")).toBe(false);

    expect(
      recordExecutionDecisionFactInDatabase(receipt("receipt-1"), {
        ...database,
        database: openOpenClawStateDatabase(database),
        now: 100,
      }),
    ).toBe("inserted");
    expect(
      recordExecutionDecisionFactInDatabase(receipt("receipt-1"), {
        ...database,
        database: openOpenClawStateDatabase(database),
        now: 100,
      }),
    ).toBe("existing");
    expect(() =>
      recordExecutionDecisionFactInDatabase(
        { ...receipt("receipt-1"), decision: { outcome: "allowed", reasonCode: "changed" } },
        { ...database, database: openOpenClawStateDatabase(database), now: 100 },
      ),
    ).toThrow("conflicts with retained state");

    expect(
      pageExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: 100,
      }).receipts,
    ).toEqual([receipt("receipt-1")]);
    expect(
      summarizeExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        now: 100,
      }),
    ).toEqual({ count: 1, coverageState: "enforced", missingEvidence: [] });
  });

  it("rejects approval duplication before creating the generic table", () => {
    const database = databaseOptions();
    expect(() =>
      recordExecutionDecisionFactInDatabase(
        {
          ...receipt("approval-duplicate"),
          source: {
            owner: "operator_approvals",
            recordRef: "approval-ref",
            decisionBoundary: "gateway.operator-approval.first-answer",
          },
        },
        { ...database, database: openOpenClawStateDatabase(database), now: 100 },
      ),
    ).toThrow("owner-native table");
    expect(tableExists(openOpenClawStateDatabase(database).db, "execution_decision_facts")).toBe(
      false,
    );
  });

  it("keeps high-cardinality summary work bounded and conservative", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    for (let index = 0; index < 130; index += 1) {
      recordExecutionDecisionFactInDatabase(receipt(`bounded-${String(index).padStart(3, "0")}`), {
        ...database,
        database: openOpenClawStateDatabase(database),
        now: 100,
        limits: { maxRows: 1_000, pruneBatchRows: 10 },
      });
    }

    expect(
      summarizeExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        now: 100,
      }),
    ).toEqual({
      count: 129,
      coverageState: "unknown",
      missingEvidence: ["decision.fact.summary_bounded"],
    });
  });

  it("pages equal-time facts by a bounded row key", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    for (const id of ["same-time-a", "same-time-b", "same-time-c"]) {
      recordExecutionDecisionFactInDatabase(receipt(id, 100), {
        ...database,
        database: openOpenClawStateDatabase(database),
        now: 100,
      });
    }

    const first = pageExecutionDecisionFactsForContextInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 1,
        now: 100,
      },
    );
    expect(first.receipts.map((item) => item.receiptId)).toEqual(["same-time-a"]);
    expect(first.entries).toEqual([
      { receipt: receipt("same-time-a", 100), selectorId: "decision-fact:1" },
    ]);
    expect(first.nextCursor).toEqual({ occurredAt: 100, rowId: expect.any(Number) });
    const second = pageExecutionDecisionFactsForContextInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        after: first.nextCursor,
        limit: 2,
        now: 100,
      },
    );
    expect(second.receipts.map((item) => item.receiptId)).toEqual(["same-time-b", "same-time-c"]);
    expect(second.entries.map((entry) => entry.selectorId)).toEqual([
      "decision-fact:2",
      "decision-fact:3",
    ]);
    expect(
      pageExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 1,
        now: 100,
      }).entries,
    ).toEqual(first.entries);
    expect(
      new Set([...first.entries, ...second.entries].map((entry) => entry.selectorId)).size,
    ).toBe(3);

    for (const decisionCursor of ["1", "001"]) {
      const legacyPage = presentExecutionDecisionReceiptsInDatabase(
        openOpenClawStateDatabase(database).db,
        {
          schema: noLifecycleBindings,
          context,
          decisionCursor,
          decisionLimit: 1,
          now: 100,
        },
      );
      expect(legacyPage.decisions.map((item) => item.receiptId)).toEqual(["same-time-a"]);
      expect(legacyPage.decisionDisplays?.map((item) => item.selectorId)).toEqual([
        "decision-fact:1",
      ]);
      expect(legacyPage.nextDecisionCursor).toMatch(/^g:/);
    }
    const legacyPage = presentExecutionDecisionReceiptsInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        schema: noLifecycleBindings,
        context,
        decisionCursor: "1",
        decisionLimit: 1,
        now: 100,
      },
    );
    const next = presentExecutionDecisionReceiptsInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        schema: noLifecycleBindings,
        context,
        decisionCursor: legacyPage.nextDecisionCursor,
        decisionLimit: 2,
        now: 100,
      },
    );
    expect(next.decisions.map((item) => item.receiptId)).toEqual(["same-time-b", "same-time-c"]);
    expect(next.decisionDisplays?.map((item) => item.selectorId)).toEqual([
      "decision-fact:2",
      "decision-fact:3",
    ]);
  });

  it("replaces unverified aggregate evidence with a fixed display marker", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    const context = createUnattributedExecutionContext();
    for (const owner of ["one", "two"] as const) {
      recordExecutionDecisionFactInDatabase(
        {
          ...receipt(owner),
          missingEvidence: Array.from(
            { length: 16 },
            (_, index) => `${owner}.missing.${String(index).padStart(2, "0")}`,
          ),
        },
        { ...database, database: openOpenClawStateDatabase(database), now: 100 },
      );
    }

    const result = presentExecutionDecisionReceiptsInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        schema: noLifecycleBindings,
        context,
        decisionLimit: 10,
        now: 100,
      },
    );
    expect(result.coverage).toEqual({
      state: "unknown",
      missingEvidence: expect.arrayContaining(["decision.display_provenance"]),
    });
    expect(JSON.stringify(result.coverage)).not.toContain("one.missing");
    expect(JSON.stringify(result.coverage)).not.toContain("two.missing");
    expect(Compile(AuditRunInspectResultSchema).Check(result)).toBe(false);
  });

  it("keeps receipt-controlled prose out of the owner display projection", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    const receiptIdSecret = "U2_R6_RECEIPT_ID_SECRET_42b17d";
    const summarySecret = "U2_R6_SUMMARY_SECRET_7c4f9a";
    const remediationCodeSecret = "U2_R6_CODE_SECRET_81d2be";
    const remediationTextSecret = "U2_R6_TEXT_SECRET_36a5c0";
    const policyRefSecret = "U2_R6_POLICY_REF_SECRET_ea731c";
    const grantRefSecret = "U2_R6_GRANT_REF_SECRET_b529f4";
    const missingEvidenceSecret = "U2_R6_MISSING_EVIDENCE_SECRET_2d97c1";
    recordExecutionDecisionFactInDatabase(
      {
        ...receipt(receiptIdSecret),
        action: {
          family: "tool",
          operation: "policy",
          summary: summarySecret,
        },
        source: {
          owner: "audit_events",
          recordRef: "forged-core-looking-record",
          decisionBoundary: "message.outbound.finished",
        },
        enforcement: {
          coverageState: "enforced",
          evaluatorRef: "forged-core-looking-evaluator",
          policyRefs: [policyRefSecret],
          grantRefs: [grantRefSecret],
          contextFieldsUsed: ["runId"],
        },
        missingEvidence: [missingEvidenceSecret],
        remediation: [{ code: remediationCodeSecret, text: remediationTextSecret }],
      },
      { ...database, database: openOpenClawStateDatabase(database), now: 100 },
    );

    const result = presentExecutionDecisionReceiptsInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        schema: noLifecycleBindings,
        context,
        decisionLimit: 10,
        now: 100,
      },
    );
    expect(result.decisionDisplays).toBeDefined();
    const displayJson = JSON.stringify(result.decisionDisplays);
    expect(displayJson).not.toContain(receiptIdSecret);
    expect(displayJson).not.toContain(summarySecret);
    expect(displayJson).not.toContain(remediationCodeSecret);
    expect(displayJson).not.toContain(remediationTextSecret);
    expect(displayJson).not.toContain(policyRefSecret);
    expect(displayJson).not.toContain(grantRefSecret);
    expect(JSON.stringify(result.coverage)).not.toContain(missingEvidenceSecret);
    expect(result.coverage).toEqual({
      state: "unknown",
      missingEvidence: expect.arrayContaining(["decision.display_provenance"]),
    });
    expect(JSON.stringify(result.decisions)).toContain(policyRefSecret);
    expect(JSON.stringify(result.decisions)).toContain(grantRefSecret);
    expect(result.decisionDisplays).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({
          summary: "Run admission was recorded without an identity-aware policy or grant decision.",
        }),
        provenance: { state: "verified", producer: "run-admission" },
      }),
      expect.objectContaining({
        selectorId: "decision-fact:1",
        action: { family: "decision", operation: "record" },
        decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
        enforcement: {
          coverageState: "unknown",
          policyCount: 0,
          grantCount: 0,
          contextFieldsUsed: [],
        },
        provenance: { state: "unverified" },
        missingEvidence: ["decision.display_provenance"],
        remediation: [],
      }),
    ]);
    expect(Compile(AuditRunInspectResultSchema).Check(result)).toBe(false);
  });

  it("rejects a generic fact whose context, execution, and run tuple is not exact", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    expect(() =>
      recordExecutionDecisionFactInDatabase(
        { ...receipt("wrong-execution"), executionId: "execution-2" },
        { ...database, database: openOpenClawStateDatabase(database) },
      ),
    ).toThrow("exact retained execution context");
    expect(tableExists(openOpenClawStateDatabase(database).db, "execution_decision_facts")).toBe(
      false,
    );
  });

  it("projects a fact as unknown when the requested tuple does not match", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    recordExecutionDecisionFactInDatabase(receipt("tuple-mismatch"), {
      ...database,
      database: openOpenClawStateDatabase(database),
      now: 100,
    });

    const page = pageExecutionDecisionFactsForContextInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        context: { contextId: "context-1", executionId: "execution-2", runId: "run-1" },
        limit: 10,
        now: 100,
      },
    );
    expect(page.entries).toEqual([
      {
        selectorId: "decision-fact:1",
        receipt: expect.objectContaining({
          decision: { outcome: "unknown", reasonCode: "decision_fact_execution_link_mismatch" },
          enforcement: expect.objectContaining({ coverageState: "unknown" }),
          missingEvidence: ["decision.execution_link"],
        }),
      },
    ]);
  });

  it("enforces the 30-day read boundary and bounded retention pruning", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    recordExecutionDecisionFactInDatabase(receipt("old", 0), {
      ...database,
      database: openOpenClawStateDatabase(database),
      now: 0,
    });
    recordExecutionDecisionFactInDatabase(receipt("new", RETENTION_MS + 1), {
      ...database,
      database: openOpenClawStateDatabase(database),
      now: RETENTION_MS + 1,
      limits: { maxRows: 10, pruneBatchRows: 1 },
    });

    expect(
      pageExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: RETENTION_MS + 1,
      }).receipts.map((item) => item.receiptId),
    ).toEqual(["new"]);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("caps retained facts without accepting a non-identical receipt id", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    for (const [index, id] of ["one", "two", "three"].entries()) {
      recordExecutionDecisionFactInDatabase(receipt(id, 100 + index), {
        ...database,
        database: openOpenClawStateDatabase(database),
        now: 100 + index,
        limits: { maxRows: 2, pruneBatchRows: 1 },
      });
    }
    expect(
      pageExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: 200,
      }).receipts.map((item) => item.receiptId),
    ).toEqual(["two", "three"]);
  });

  it("turns corrupt retained payloads into bounded unknown receipts", () => {
    const database = databaseOptions();
    seedExecutionContext(database);
    const context = createUnattributedExecutionContext();
    recordExecutionDecisionFactInDatabase(receipt("corrupt"), {
      ...database,
      database: openOpenClawStateDatabase(database),
      now: 100,
    });
    openOpenClawStateDatabase(database)
      .db.prepare("UPDATE execution_decision_facts SET receipt_json = ? WHERE receipt_id = ?")
      .run("{", "corrupt");

    const page = pageExecutionDecisionFactsForContextInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 10,
        now: 100,
      },
    );
    expect(page.entries).toEqual([
      {
        selectorId: "decision-fact:1",
        receipt: expect.objectContaining({
          receiptId: "corrupt",
          decision: { outcome: "unknown", reasonCode: "decision_fact_record_corrupt" },
          enforcement: expect.objectContaining({ coverageState: "unknown" }),
          missingEvidence: ["decision.fact.valid"],
        }),
      },
    ]);
    expect(
      summarizeExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        now: 100,
      }),
    ).toEqual({
      count: 1,
      coverageState: "unknown",
      missingEvidence: ["decision.fact.valid"],
    });
    expect(
      presentExecutionDecisionReceiptsInDatabase(openOpenClawStateDatabase(database).db, {
        schema: noLifecycleBindings,
        context,
        decisionCursor: "g:0:0",
        decisionLimit: 10,
        now: 100,
      }),
    ).toMatchObject({
      coverage: {
        state: "unknown",
        missingEvidence: expect.arrayContaining(["decision.display_provenance"]),
      },
      decisions: [{ decision: { outcome: "unknown", reasonCode: "decision_fact_record_corrupt" } }],
      decisionDisplays: [{ selectorId: "decision-fact:1" }],
    });
  });

  it("does not materialize an oversized retained fact payload", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    recordExecutionDecisionFactInDatabase(receipt("oversized"), {
      ...database,
      database: openOpenClawStateDatabase(database),
      now: 100,
    });
    const db = openOpenClawStateDatabase(database).db;
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE execution_decision_facts SET receipt_json = ? WHERE receipt_id = ?").run(
      "x".repeat(20_000),
      "oversized",
    );

    const page = pageExecutionDecisionFactsForContextInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
        limit: 1,
        now: 100,
      },
    );
    expect(page.entries).toEqual([
      {
        selectorId: "decision-fact:1",
        receipt: expect.objectContaining({
          decision: { outcome: "unknown", reasonCode: "decision_fact_payload_bounded" },
          missingEvidence: ["decision.fact.payload_bounded"],
        }),
      },
    ]);
    const result = presentExecutionDecisionReceiptsInDatabase(
      openOpenClawStateDatabase(database).db,
      {
        schema: noLifecycleBindings,
        context,
        decisionCursor: "g:0:0",
        decisionLimit: 1,
        now: 100,
      },
    );
    expect(result.decisions).toHaveLength(1);
    expect(result.decisionDisplays).toEqual([
      expect.objectContaining({ selectorId: "decision-fact:1" }),
    ]);
  });
});
