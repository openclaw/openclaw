// Persistent operator approval store tests cover terminal CAS, expiry, replay, and recovery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withSqliteWriteAdmissionService } from "../infra/sqlite-transaction.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  closeOrphanedOperatorApprovals,
  consumeOperatorApprovalAllowOnce,
  expireDueOperatorApprovals,
  forceDenyOperatorApproval,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  listPendingOperatorApprovals,
  listTerminalOperatorApprovals,
  OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS,
  OperatorApprovalHistoryCursorError,
  pruneTerminalOperatorApprovals,
  resolveOperatorApproval,
} from "./operator-approval-store.js";
import { executeOperatorApprovalCommand } from "./operator-approval-store.worker.js";

type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
const OPERATOR_APPROVAL_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

async function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
  const result = await getOperatorApprovalDetailed(params);
  return result.outcome === "found" ? result.record : null;
}

const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-operator-approval-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function approval(id: string, overrides: Partial<NewOperatorApproval> = {}): NewOperatorApproval {
  const kind = overrides.kind ?? overrides.presentation?.kind ?? "exec";
  const presentation: NewOperatorApproval["presentation"] =
    overrides.presentation ??
    (kind === "exec"
      ? {
          kind: "exec" as const,
          commandText: `echo ${id}`,
          commandPreview: `echo ${id}`,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        }
      : {
          kind: "plugin" as const,
          title: "Approve plugin action",
          description: `Allow the plugin action for ${id}.`,
          severity: "warning" as const,
          pluginId: "test-plugin",
          toolName: "test-tool",
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        });
  return {
    id,
    kind,
    presentation,
    requester: {
      deviceId: "request-device",
      clientId: "request-client",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: ["reviewer-b", "reviewer-a", "reviewer-b"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

function rawApprovalRow(options: OpenClawStateDatabaseOptions, id: string) {
  const database = openOpenClawStateDatabase(options);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

describe("operator approval store", () => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("round-trips only the safe presentation and durable routing metadata across reopen", async () => {
    const databaseOptions = createDatabaseOptions();

    const inserted = await insertOperatorApproval({
      approval: approval("round-trip"),
      databaseOptions,
    });
    expect(inserted.outcome).toBe("inserted");
    if (inserted.outcome !== "inserted") {
      throw new Error("expected approval insert");
    }
    expect(inserted.record).toMatchObject({
      id: "round-trip",
      resolutionRef: buildApprovalResolutionRef({
        approvalId: "round-trip",
        approvalKind: "exec",
      }),
      kind: "exec",
      status: "pending",
      presentation: {
        kind: "exec",
        commandText: "echo round-trip",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
      requester: {
        deviceId: "request-device",
        clientId: "request-client",
        deviceTokenAuth: true,
      },
      reviewerDeviceIds: ["reviewer-b", "reviewer-a"],
      source: {
        agentId: "main",
        sessionKey: "agent:main:child",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "tool-call-1",
        toolName: "exec",
      },
      audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
      runtimeEpoch: "runtime-a",
    });

    expect(
      await insertOperatorApproval({
        approval: approval("plugin", { kind: "plugin", createdAtMs: 1_001 }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted", record: { id: "plugin", kind: "plugin" } });

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    expect(await getOperatorApproval({ id: "round-trip", nowMs: 2_000, databaseOptions })).toEqual(
      inserted.record,
    );
    expect(
      await getOperatorApprovalDetailed({
        id: inserted.record.resolutionRef,
        allowTransportRef: true,
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "found", record: inserted.record });
    expect(await listPendingOperatorApprovals({ nowMs: 2_000, databaseOptions })).toEqual([
      inserted.record,
      expect.objectContaining({ id: "plugin", kind: "plugin" }),
    ]);
  });

  it("lists terminal history newest-first with kind filtering and keyset pagination", async () => {
    const databaseOptions = createDatabaseOptions();
    const entries: NewOperatorApproval[] = [
      approval("exec-old", { createdAtMs: 1_000 }),
      approval("plugin-new", { kind: "plugin", createdAtMs: 1_001 }),
      approval("system-middle", {
        kind: "system-agent",
        presentation: {
          kind: "system-agent",
          title: "Approve system change",
          description: "Apply the proposed system-agent change.",
          proposalHash: "a".repeat(64),
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_002,
      }),
      approval("still-pending", { createdAtMs: 1_003 }),
    ];
    for (const entry of entries) {
      expect(await insertOperatorApproval({ approval: entry, databaseOptions })).toMatchObject({
        outcome: "inserted",
      });
    }
    for (const [id, nowMs] of [
      ["exec-old", 2_000],
      ["system-middle", 3_000],
      ["plugin-new", 3_000],
    ] as const) {
      expect(
        await resolveOperatorApproval({
          id,
          decision: "deny",
          resolver: { kind: "device", id: "reviewer-device" },
          nowMs,
          databaseOptions,
        }),
      ).toMatchObject({ outcome: "resolved" });
    }

    const firstPage = await listTerminalOperatorApprovals({
      limit: 2,
      nowMs: 3_000,
      databaseOptions,
    });
    expect(firstPage.records.map((record) => record.id)).toEqual(["system-middle", "plugin-new"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    if (!firstPage.nextCursor) {
      throw new Error("expected terminal history cursor");
    }

    const cursorPayload = JSON.parse(
      Buffer.from(firstPage.nextCursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const nonEmittedCursor = Buffer.from(
      JSON.stringify({ ...cursorPayload, extra: true }),
      "utf8",
    ).toString("base64url");
    for (const cursor of [
      `${firstPage.nextCursor}!`,
      `${firstPage.nextCursor}=`,
      nonEmittedCursor,
    ]) {
      await expect(
        listTerminalOperatorApprovals({ cursor, nowMs: 3_000, databaseOptions }),
      ).rejects.toThrow(OperatorApprovalHistoryCursorError);
    }

    const secondPage = await listTerminalOperatorApprovals({
      cursor: firstPage.nextCursor,
      limit: 2,
      nowMs: 3_000,
      databaseOptions,
    });
    expect(secondPage.records.map((record) => record.id)).toEqual(["exec-old"]);
    expect(secondPage.nextCursor).toBeUndefined();

    expect(
      (
        await listTerminalOperatorApprovals({ kind: "plugin", nowMs: 3_000, databaseOptions })
      ).records.map((record) => record.id),
    ).toEqual(["plugin-new"]);
  });

  it("excludes terminal rows resolved before the 30-day retention cutoff", async () => {
    const databaseOptions = createDatabaseOptions();
    const day = 24 * 60 * 60_000;
    const now = 100 * day;
    expect(
      await insertOperatorApproval({
        approval: approval("old", { createdAtMs: 1_000, expiresAtMs: now }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });
    expect(
      await insertOperatorApproval({
        approval: approval("recent", { createdAtMs: now - 2 * day, expiresAtMs: now }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });
    // Resolve one row 40 days ago (past the window) and one 1 day ago (inside).
    expect(
      await resolveOperatorApproval({
        id: "old",
        decision: "deny",
        resolver: { kind: "device", id: "reviewer-device" },
        nowMs: now - 40 * day,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      await resolveOperatorApproval({
        id: "recent",
        decision: "deny",
        resolver: { kind: "device", id: "reviewer-device" },
        nowMs: now - day,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "resolved" });

    expect(
      (await listTerminalOperatorApprovals({ nowMs: now, databaseOptions })).records.map(
        (record) => record.id,
      ),
    ).toEqual(["recent"]);
  });

  it("filters an audience before applying the replay limit across scan pages", async () => {
    const databaseOptions = createDatabaseOptions();
    for (let index = 0; index < 256; index += 1) {
      const id = `unrelated-${String(index).padStart(3, "0")}`;
      expect(
        await insertOperatorApproval({
          approval: approval(id, {
            audienceSessionKeys: ["agent:main:other"],
            createdAtMs: 1_000 + index,
          }),
          databaseOptions,
        }),
      ).toMatchObject({ outcome: "inserted" });
    }
    expect(
      await insertOperatorApproval({
        approval: approval("target-after-first-page", {
          audienceSessionKeys: ["agent:main:target"],
          createdAtMs: 2_000,
        }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });

    expect(
      await listPendingOperatorApprovals({
        audienceSessionKey: "agent:main:target",
        limit: 1,
        nowMs: 3_000,
        databaseOptions,
      }),
    ).toMatchObject([{ id: "target-after-first-page" }]);
  });

  it("filters reviewers before the replay limit across scan pages", async () => {
    const databaseOptions = createDatabaseOptions();
    for (let index = 0; index < 256; index += 1) {
      const id = `unrelated-reviewer-${String(index).padStart(3, "0")}`;
      expect(
        await insertOperatorApproval({
          approval: approval(id, {
            reviewerDeviceIds: ["unrelated-device"],
            createdAtMs: 1_000 + index,
          }),
          databaseOptions,
        }),
      ).toMatchObject({ outcome: "inserted" });
    }
    expect(
      await insertOperatorApproval({
        approval: approval("authorized-after-first-page", {
          reviewerDeviceIds: ["authorized-device"],
          createdAtMs: 2_000,
        }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });

    expect(
      await listPendingOperatorApprovals({
        reviewerDeviceId: "authorized-device",
        limit: 1,
        nowMs: 3_000,
        databaseOptions,
      }),
    ).toMatchObject([{ id: "authorized-after-first-page" }]);
  });

  it("reads the default clock after waiting for the SQLite write lock", async () => {
    const databaseOptions = createDatabaseOptions();
    const createdAtMs = 1_000;
    const expiresAtMs = 2_000;
    await insertOperatorApproval({
      approval: approval("lock-delayed-clock", { createdAtMs, expiresAtMs }),
      databaseOptions,
    });
    const database = openOpenClawStateDatabase(databaseOptions);
    const writer = new DatabaseSync(database.path);
    using clock = vi.spyOn(Date, "now").mockReturnValue(createdAtMs);
    // Run the real worker transaction locally so its clock is controlled; transport authority
    // is covered separately by the worker integration tests.
    using _ = vi
      .spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission")
      .mockImplementation(() => {});
    const releaseWriter = vi.fn(() => {
      writer.exec("COMMIT");
      clock.mockReturnValue(3_000);
    });
    try {
      writer.exec("BEGIN IMMEDIATE");
      expect(Date.now()).toBeLessThan(expiresAtMs);
      const result = await withSqliteWriteAdmissionService(database.db, releaseWriter, async () =>
        executeOperatorApprovalCommand(
          { type: "operatorApprovals.get", input: { id: "lock-delayed-clock" } },
          databaseOptions,
        ),
      );

      expect(releaseWriter).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        outcome: "found",
        record: { status: "expired", terminalReason: "timeout" },
      });
    } finally {
      writer.close();
    }
  });

  it("preserves BOM, NBSP, and boundary spaces as opaque approval identity", async () => {
    const databaseOptions = createDatabaseOptions();
    for (const [index, id] of ["\uFEFF", "\u00A0", " approval-edge "].entries()) {
      const inserted = await insertOperatorApproval({
        approval: approval(id, { createdAtMs: 1_000 + index }),
        databaseOptions,
      });

      expect(inserted).toMatchObject({ outcome: "inserted", record: { id } });
      expect(await getOperatorApproval({ id, nowMs: 2_000, databaseOptions })).toMatchObject({
        id,
        status: "pending",
      });
    }
    expect(
      await getOperatorApproval({ id: "approval-edge", nowMs: 2_000, databaseOptions }),
    ).toBeNull();
  });

  it("rejects presentations outside the canonical safe protocol schema", async () => {
    const databaseOptions = createDatabaseOptions();
    const base = approval("unsafe-presentation");
    const unsafePresentation = {
      ...base.presentation,
      env: { SECRET_TOKEN: "must-not-persist" },
    } as unknown as NewOperatorApproval["presentation"];

    await expect(
      insertOperatorApproval({
        approval: { ...base, presentation: unsafePresentation },
        databaseOptions,
      }),
    ).rejects.toThrow(/safe protocol schema/);
    expect(rawApprovalRow(databaseOptions, base.id)).toBeUndefined();
  });

  it("rejects approval ids that cannot form stable deep-link path segments", async () => {
    const databaseOptions = createDatabaseOptions();
    for (const id of ["\ud800", "\udc00", ".", ".."]) {
      await expect(
        insertOperatorApproval({ approval: approval(id), databaseOptions }),
      ).rejects.toThrow(/approval id/);
      await expect(getOperatorApproval({ id, databaseOptions })).rejects.toThrow(/approval id/);
      await expect(
        resolveOperatorApproval({
          id,
          decision: "deny",
          resolver: { kind: "system", id: null },
          databaseOptions,
        }),
      ).rejects.toThrow(/approval id/);
    }
  });

  it("keeps canonical ids and transport references in disjoint lookup namespaces", async () => {
    const databaseOptions = createDatabaseOptions();
    const inserted = await insertOperatorApproval({
      approval: approval("namespace-owner"),
      databaseOptions,
    });
    if (inserted.outcome !== "inserted") {
      throw new Error("expected approval insert");
    }

    expect(
      await insertOperatorApproval({
        approval: approval(inserted.record.resolutionRef, { createdAtMs: 1_001 }),
        databaseOptions,
      }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await getOperatorApprovalDetailed({
        id: inserted.record.resolutionRef,
        allowTransportRef: true,
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "found", record: inserted.record });

    const futureId = "namespace-future-owner";
    const futureRef = buildApprovalResolutionRef({ approvalId: futureId, approvalKind: "exec" });
    expect(
      await insertOperatorApproval({
        approval: approval(futureRef, { createdAtMs: 1_002 }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });
    expect(
      await insertOperatorApproval({
        approval: approval(futureId, { createdAtMs: 1_003 }),
        databaseOptions,
      }),
    ).toEqual({ outcome: "conflict" });
  });

  it("prunes retained terminal rows before checking locator namespace conflicts", async () => {
    const databaseOptions = createDatabaseOptions();
    const inserted = await insertOperatorApproval({
      approval: approval("expired-namespace-owner"),
      databaseOptions,
    });
    if (inserted.outcome !== "inserted") {
      throw new Error("expected approval insert");
    }
    await forceDenyOperatorApproval({
      id: inserted.record.id,
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 2_000,
      databaseOptions,
    });
    const createdAtMs = OPERATOR_APPROVAL_TERMINAL_RETENTION_MS + 3_000;

    expect(
      await insertOperatorApproval({
        approval: approval(inserted.record.resolutionRef, {
          createdAtMs,
          expiresAtMs: createdAtMs + 10_000,
        }),
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "inserted" });
    expect(rawApprovalRow(databaseOptions, inserted.record.id)).toBeUndefined();
  });

  it("returns the first terminal answer and distinguishes same and conflicting retries", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({ approval: approval("first-wins"), databaseOptions });

    const winner = await resolveOperatorApproval({
      id: "first-wins",
      decision: "allow-once",
      resolver: { kind: "device", id: "winner-device" },
      nowMs: 2_000,
      databaseOptions,
    });
    const sameRetry = await resolveOperatorApproval({
      id: "first-wins",
      decision: "allow-once",
      resolver: { kind: "channel", id: "telegram:loser" },
      nowMs: 2_001,
      databaseOptions,
    });
    const conflictingRetry = await resolveOperatorApproval({
      id: "first-wins",
      decision: "deny",
      resolver: { kind: "channel", id: "telegram:loser" },
      nowMs: 2_002,
      databaseOptions,
    });

    expect(winner).toMatchObject({
      outcome: "resolved",
      record: {
        status: "allowed",
        decision: "allow-once",
        resolver: { kind: "device", id: "winner-device" },
      },
    });
    expect(sameRetry).toMatchObject({
      outcome: "already-resolved",
      retry: "same",
      record: { resolver: { kind: "device", id: "winner-device" } },
    });
    expect(conflictingRetry).toMatchObject({
      outcome: "already-resolved",
      retry: "conflict",
      record: { decision: "allow-once" },
    });
  });

  it("expires at the exact deadline and never accepts a late allow", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({
      approval: approval("deadline", { expiresAtMs: 2_000 }),
      databaseOptions,
    });

    const deadlineResult = await resolveOperatorApproval({
      id: "deadline",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
      databaseOptions,
    });
    const lateResult = await resolveOperatorApproval({
      id: "deadline",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_001,
      databaseOptions,
    });

    expect(deadlineResult).toMatchObject({
      outcome: "expired",
      record: { status: "expired", decision: "deny", terminalReason: "timeout" },
    });
    expect(lateResult).toMatchObject({
      outcome: "already-resolved",
      retry: "conflict",
      record: { status: "expired", decision: "deny" },
    });
  });

  it("expires before a trusted force-deny verdict at the exact deadline", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({
      approval: approval("force-deadline", { expiresAtMs: 2_000 }),
      databaseOptions,
    });

    expect(
      await forceDenyOperatorApproval({
        id: "force-deadline",
        reason: "malformed-verdict",
        resolver: { kind: "runtime", id: "harness" },
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "expired",
      record: { status: "expired", decision: "deny", terminalReason: "timeout" },
    });
  });

  it("keeps an early expiry callback pending until the authoritative deadline", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({
      approval: approval("early-expiry", { expiresAtMs: 2_000 }),
      databaseOptions,
    });

    expect(
      await forceDenyOperatorApproval({
        id: "early-expiry",
        status: "expired",
        requireDue: true,
        reason: "timeout",
        resolver: { kind: "system", id: null },
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
        nowMs: 1_999,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "not-due", record: { status: "pending" } });
    expect(
      await getOperatorApproval({ id: "early-expiry", nowMs: 1_999, databaseOptions }),
    ).toMatchObject({ status: "pending" });
  });

  it("hides approvals from resolvers with the wrong kind or runtime epoch", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({ approval: approval("guarded"), databaseOptions });

    expect(
      await resolveOperatorApproval({
        id: "guarded",
        decision: "allow-once",
        resolver: { kind: "runtime", id: "runtime" },
        expectedKind: "plugin",
        runtimeEpoch: "runtime-a",
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(
      await forceDenyOperatorApproval({
        id: "guarded",
        reason: "run-aborted",
        resolver: { kind: "runtime", id: "runtime" },
        expectedKind: "exec",
        runtimeEpoch: "runtime-b",
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(
      await getOperatorApproval({ id: "guarded", nowMs: 2_000, databaseOptions }),
    ).toMatchObject({
      status: "pending",
    });

    await resolveOperatorApproval({
      id: "guarded",
      decision: "allow-once",
      resolver: { kind: "runtime", id: "runtime" },
      expectedKind: "exec",
      runtimeEpoch: "runtime-a",
      nowMs: 2_000,
      databaseOptions,
    });
    expect(
      await consumeOperatorApprovalAllowOnce({
        id: "guarded",
        consumerId: "run-1:tool-call-1",
        expectedKind: "plugin",
        runtimeEpoch: "runtime-a",
        nowMs: 2_001,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(
      await consumeOperatorApprovalAllowOnce({
        id: "guarded",
        consumerId: "run-1:tool-call-1",
        expectedKind: "exec",
        runtimeEpoch: "runtime-b",
        nowMs: 2_001,
        databaseOptions,
      }),
    ).toEqual({ outcome: "not-found" });
    expect(
      await consumeOperatorApprovalAllowOnce({
        id: "guarded",
        consumerId: "run-1:tool-call-1",
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
        nowMs: 2_001,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "consumed" });
  });

  it("expires every due row in one fail-closed maintenance pass", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({
      approval: approval("due-a", { expiresAtMs: 2_000 }),
      databaseOptions,
    });
    await insertOperatorApproval({
      approval: approval("due-b", { expiresAtMs: 3_000 }),
      databaseOptions,
    });
    await insertOperatorApproval({ approval: approval("future"), databaseOptions });

    const result = await expireDueOperatorApprovals({ nowMs: 3_000, databaseOptions });

    expect(result.affected).toBe(2);
    expect(result.records.map((record) => [record.id, record.status])).toEqual([
      ["due-a", "expired"],
      ["due-b", "expired"],
    ]);
    expect(await listPendingOperatorApprovals({ nowMs: 3_000, databaseOptions })).toMatchObject([
      { id: "future" },
    ]);
  });

  it("consumes allow-once exactly once without erasing the terminal decision", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({
      approval: approval("consume", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    const resolved = await resolveOperatorApproval({
      id: "consume",
      decision: "allow-once",
      resolver: { kind: "runtime", id: "approval-runtime" },
      nowMs: 2_000,
      databaseOptions,
    });
    expect(resolved).toMatchObject({
      outcome: "resolved",
      record: { resolvedAtMs: 5_000, updatedAtMs: 5_000 },
    });

    const first = await consumeOperatorApprovalAllowOnce({
      id: "consume",
      consumerId: "run-1:tool-call-1",
      redemptionWindowMs: 15_000,
      nowMs: 3_000,
      databaseOptions,
    });
    const replay = await consumeOperatorApprovalAllowOnce({
      id: "consume",
      consumerId: "run-1:tool-call-1",
      redemptionWindowMs: 15_000,
      nowMs: 3_001,
      databaseOptions,
    });

    expect(first).toMatchObject({
      outcome: "consumed",
      record: {
        status: "allowed",
        decision: "allow-once",
        consumedAtMs: 5_000,
        consumedBy: "run-1:tool-call-1",
      },
    });
    expect(replay).toMatchObject({
      outcome: "already-consumed",
      record: { decision: "allow-once", consumedAtMs: 5_000 },
    });
  });

  it("rejects allow-once redemption at the exact grace boundary", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({ approval: approval("stale-redemption"), databaseOptions });
    await resolveOperatorApproval({
      id: "stale-redemption",
      decision: "allow-once",
      resolver: { kind: "runtime", id: "approval-runtime" },
      nowMs: 2_000,
      databaseOptions,
    });

    expect(
      await consumeOperatorApprovalAllowOnce({
        id: "stale-redemption",
        consumerId: "run-1:tool-call-1",
        redemptionWindowMs: 1_000,
        nowMs: 3_000,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "redemption-expired",
      record: { resolvedAtMs: 2_000, consumedAtMs: null },
    });
  });

  it("cancels pending rows from older runtime epochs after reopen", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({
      approval: approval("orphan", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    await insertOperatorApproval({
      approval: approval("current", { runtimeEpoch: "runtime-b" }),
      databaseOptions,
    });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const result = closeOrphanedOperatorApprovals({
      runtimeEpoch: "runtime-b",
      nowMs: 2_000,
      databaseOptions,
    });

    expect(result).toMatchObject({
      affected: 1,
      records: [
        {
          id: "orphan",
          status: "cancelled",
          decision: "deny",
          terminalReason: "gateway-restart",
          resolvedAtMs: 5_000,
          updatedAtMs: 5_000,
        },
      ],
    });
    expect(
      await getOperatorApproval({ id: "current", nowMs: 2_000, databaseOptions }),
    ).toMatchObject({
      status: "pending",
    });
  });

  it("terminalizes a corrupt pending row and never returns it as approvable", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({
      approval: approval("corrupt", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({ presentation_json: "{not-json" })
        .where("approval_id", "=", "corrupt"),
    );

    expect(
      await getOperatorApprovalDetailed({ id: "corrupt", nowMs: 2_000, databaseOptions }),
    ).toEqual({
      outcome: "corrupt",
    });
    expect(await getOperatorApproval({ id: "corrupt", nowMs: 2_000, databaseOptions })).toBeNull();
    expect(rawApprovalRow(databaseOptions, "corrupt")).toMatchObject({
      status: "denied",
      decision: "deny",
      terminal_reason: "storage-corrupt",
      resolver_kind: "system",
      resolved_at_ms: 5_000,
      updated_at_ms: 5_000,
    });
  });

  it("fails closed for forged terminal status tuples", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({ approval: approval("forged-allowed"), databaseOptions });
    await insertOperatorApproval({ approval: approval("forged-denied"), databaseOptions });
    await resolveOperatorApproval({
      id: "forged-allowed",
      decision: "allow-once",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
      databaseOptions,
    });
    await resolveOperatorApproval({
      id: "forged-denied",
      decision: "deny",
      resolver: { kind: "device", id: "reviewer" },
      nowMs: 2_000,
      databaseOptions,
    });
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    // Simulate external corruption that bypassed SQLite CHECK constraints; the
    // decoder must independently reject these approval-granting tuples.
    database.db.exec("PRAGMA ignore_check_constraints = ON");
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({ terminal_reason: "storage-corrupt" })
        .where("approval_id", "=", "forged-allowed"),
    );
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({ decision: "allow-once" })
        .where("approval_id", "=", "forged-denied"),
    );
    database.db.exec("PRAGMA ignore_check_constraints = OFF");

    expect(
      await getOperatorApprovalDetailed({ id: "forged-allowed", nowMs: 2_001, databaseOptions }),
    ).toEqual({ outcome: "corrupt" });
    expect(
      await getOperatorApprovalDetailed({ id: "forged-denied", nowMs: 2_001, databaseOptions }),
    ).toEqual({ outcome: "corrupt" });
  });

  it("prunes only terminal rows outside the 30-day retention window", async () => {
    const databaseOptions = createDatabaseOptions();
    const nowMs = OPERATOR_APPROVAL_TERMINAL_RETENTION_MS + 10_000;
    await insertOperatorApproval({
      approval: approval("old-terminal", { createdAtMs: 5_000 }),
      databaseOptions,
    });
    await insertOperatorApproval({ approval: approval("recent-terminal"), databaseOptions });
    await insertOperatorApproval({ approval: approval("still-pending"), databaseOptions });
    await forceDenyOperatorApproval({
      id: "old-terminal",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 4_000,
      databaseOptions,
    });
    expect(rawApprovalRow(databaseOptions, "old-terminal")).toMatchObject({
      resolved_at_ms: 5_000,
      updated_at_ms: 5_000,
    });
    await forceDenyOperatorApproval({
      id: "recent-terminal",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: nowMs - 100,
      databaseOptions,
    });

    expect(pruneTerminalOperatorApprovals({ nowMs, databaseOptions })).toBe(1);
    expect(rawApprovalRow(databaseOptions, "old-terminal")).toBeUndefined();
    expect(rawApprovalRow(databaseOptions, "recent-terminal")).toBeDefined();
    expect(rawApprovalRow(databaseOptions, "still-pending")).toBeDefined();
  });

  it("prunes old terminal rows opportunistically when inserting", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertOperatorApproval({ approval: approval("old-on-insert"), databaseOptions });
    await forceDenyOperatorApproval({
      id: "old-on-insert",
      status: "cancelled",
      reason: "run-aborted",
      resolver: { kind: "system", id: null },
      nowMs: 2_000,
      databaseOptions,
    });
    const createdAtMs = OPERATOR_APPROVAL_TERMINAL_RETENTION_MS + 2_000;

    await insertOperatorApproval({
      approval: approval("prune-trigger", {
        createdAtMs,
        expiresAtMs: createdAtMs + 1_000,
      }),
      databaseOptions,
    });

    expect(rawApprovalRow(databaseOptions, "old-on-insert")).toBeUndefined();
    expect(rawApprovalRow(databaseOptions, "prune-trigger")).toMatchObject({ status: "pending" });
  });

  it("rejects an unbounded ancestor audience", async () => {
    const databaseOptions = createDatabaseOptions();
    const audienceSessionKeys = Array.from(
      { length: OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS + 1 },
      (_, index) => `agent:main:${index}`,
    );

    await expect(
      insertOperatorApproval({
        approval: approval("large-audience", { audienceSessionKeys }),
        databaseOptions,
      }),
    ).rejects.toThrow(/audience exceeds/);
  });
});
