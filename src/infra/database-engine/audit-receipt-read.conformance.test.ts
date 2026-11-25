import { describe, expect, it } from "vitest";
import { recordExecutionDecisionFactInDatabase } from "../../audit/execution-decision-facts.js";
import {
  receipt,
  seedExecutionContext,
} from "../../audit/execution-decision-facts.test-support.js";
import { inspectExecutionIdentityRun } from "../../audit/execution-identity-context.js";
import { recordDeniedApprovalForRun } from "../../audit/execution-identity.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const engines = mixedAgentConnection ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

describe.each(engines)("%s exact execution audit reads", (engine) => {
  useMixedAgentPair(engine, engine);

  it("pages exact, redacted receipts and preserves multibyte byte bounds", async () => {
    const context = withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase();
      expect(isPostgresSqlConnection(database.db)).toBe(engine === "postgres");
      const seededContext = seedExecutionContext({ database });
      const valid = receipt("generic-valid");
      valid.action.summary = "private-fact-内容";
      for (const fact of [valid, receipt("generic-oversized", 101)]) {
        expect(recordExecutionDecisionFactInDatabase(fact, { database, now: 300 })).toBe(
          "inserted",
        );
      }
      // A retained payload can disagree with its declared byte count. The text is
      // under the cap in characters but over it in UTF-8 bytes.
      database.db
        .prepare("UPDATE execution_decision_facts SET receipt_json = ? WHERE receipt_id = ?")
        .run(JSON.stringify("界".repeat(6_000)), "generic-oversized");
      return seededContext;
    });
    await recordDeniedApprovalForRun(context.runId, {}, "approval-a-exact", context);
    await recordDeniedApprovalForRun(context.runId, {}, "approval-b-oversized", context);
    await recordDeniedApprovalForRun(context.runId, {}, "approval-c-other", {
      ...context,
      executionId: "other-execution",
    });
    withEngineStoreAdmission(() => {
      // Neither JSON column alone exceeds 64 KiB; their UTF-8 sum does.
      const payload = JSON.stringify(["界".repeat(12_000)]);
      openOpenClawStateDatabase()
        .db.prepare(
          "UPDATE operator_approvals SET reviewer_device_ids_json = ?, audience_session_keys_json = ? WHERE approval_id = ?",
        )
        .run(payload, payload, "approval-b-oversized");
    });

    const first = await inspectExecutionIdentityRun(
      { executionId: context.executionId, decisionLimit: 2 },
      { now: 300 },
    );
    expect(first.run).toEqual({
      runId: context.runId,
      executionId: context.executionId,
      status: "known",
    });
    expect(first.decisionDisplays).toMatchObject([
      { selectorId: "context-1:admission" },
      {
        selectorId: "approval-decision:1",
        decision: { outcome: "denied", reasonCode: "operator_approval_denied_by_reviewer" },
        enforcement: { coverageState: "enforced" },
      },
    ]);
    expect(first.nextDecisionCursor).toBe("a:200:1");

    const next = await inspectExecutionIdentityRun(
      {
        executionId: context.executionId,
        decisionCursor: first.nextDecisionCursor,
        decisionLimit: 4,
      },
      { now: 300 },
    );
    expect(next.decisionDisplays).toMatchObject([
      {
        selectorId: "approval-decision:2",
        decision: { outcome: "unknown", reasonCode: "operator_approval_payload_bounded" },
      },
      {
        selectorId: "approval-decision:3",
        decision: { outcome: "unknown", reasonCode: "operator_approval_execution_link_mismatch" },
        enforcement: { coverageState: "unknown", grantCount: 0 },
      },
      { selectorId: "decision-fact:1", action: { family: "decision", operation: "record" } },
      { selectorId: "decision-fact:2", action: { family: "decision", operation: "record" } },
    ]);
    expect(next.decisions.slice(2).map(({ decision }) => decision.reasonCode)).toEqual([
      "tool_policy_denied",
      "decision_fact_payload_bounded",
    ]);
    expect(
      JSON.stringify({ first: first.decisionDisplays, next: next.decisionDisplays }),
    ).not.toMatch(/details withheld|private-reviewer-device|private-fact-内容|界/u);
  });
});
