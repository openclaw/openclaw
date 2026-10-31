import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { listAuditEvents, recordAuditEventInDatabase } from "./audit-event-store.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import {
  input,
  messageEvent,
  decisionReceipt,
  captureWork,
} from "./audit-event-writer.test-support.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import { pageExecutionDecisionFactsForContextInDatabase } from "./execution-decision-facts.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "./execution-identity-admission.js";
import { inspectExecutionIdentityRun } from "./execution-identity-context.js";
import {
  captureExecutionIdentityAdmissionEnvelope,
  executionIdentityFacts,
  persistExecutionIdentityAdmissionEnvelope,
} from "./execution-identity.test-support.js";

function defineObjectPrototypeProperties(descriptors: PropertyDescriptorMap): void {
  // oxlint-disable-next-line no-extend-native -- Exercise hostile prototype pollution across the real clone boundary.
  Object.defineProperties(Object.prototype, descriptors);
}

const tempDirs = createTempDirTracker();

function databaseFixture() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-writer-") } };
}

function startWriter(database: ReturnType<typeof databaseFixture>, maxPending?: number) {
  const errors: string[] = [];
  const writer = createAuditEventWriter({
    scheduler: createTestGatewayScheduler(),
    stateDir: database.env.OPENCLAW_STATE_DIR,
    maxPending,
    onError: (error) => errors.push(error),
  });
  return { writer, errors };
}

function envelopeFor(
  runId: string,
  options: Parameters<typeof captureExecutionIdentityAdmissionEnvelope>[1] = {},
  facts: Parameters<typeof executionIdentityFacts>[1] = {},
) {
  return captureExecutionIdentityAdmissionEnvelope(executionIdentityFacts(runId, facts), {
    runtimeInstanceId: "runtime-1",
    ...options,
  });
}

async function runIds(database: ReturnType<typeof databaseFixture>) {
  return (await listAuditEvents({ database, limit: 10 })).events.map((event) => event.runId);
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("audit event writer", () => {
  it("rejects one uncloneable event without disabling later audit records", async () => {
    const database = databaseFixture();
    const { writer, errors } = startWriter(database);
    try {
      await writer.ready;
      expect(writer.record({ ...input(), sourceId: "before", runId: "before" })).toBe(true);
      const invalid = { ...input(), uncloneable: () => {} };
      expect(writer.record(invalid)).toBe(false);
      expect(writer.record({ ...input(), sourceId: "after", runId: "after" })).toBe(true);
    } finally {
      await writer.stop();
    }
    expect(errors).toHaveLength(1);
    expect(await runIds(database)).toEqual(["after", "before"]);
  });

  it("preserves external supervision for claimed state writes", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-external-");
    const supervisedDatabase = {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SUPERVISOR_MODE: "external",
      },
    };
    claimOpenClawStateOwnership("gateway-test-supervisor", supervisedDatabase);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const write = (runId: string, supervisorMode: string | undefined) =>
      withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: supervisorMode }, async () => {
        const { writer, errors } = startWriter(supervisedDatabase);
        await writer.ready;
        expect(writer.record({ ...input(), sourceId: `${runId}:1:started`, runId })).toBe(true);
        await writer.stop();
        return errors;
      });

    const supervisedErrors = await write("supervised-run", "external");
    expect(supervisedErrors).toEqual([]);
    expect(await runIds(supervisedDatabase)).toEqual(["supervised-run"]);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const unmarkedErrors = await write("unmarked-run", undefined);
    expect(unmarkedErrors.some((error) => error.includes("gateway-test-supervisor"))).toBe(true);
    expect(await runIds(supervisedDatabase)).toEqual(["supervised-run"]);
  });

  it("keeps disabled progress absent and drains accepted progress after disabling collection", async () => {
    const database = databaseFixture();
    let config: OpenClawConfig = { logging: { audit: { enabled: false, messages: "all" } } };
    const { writer } = startWriter(database);
    const recorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => config,
      writer,
    });
    await writer.ready;
    expect(tableExists(openOpenClawStateDatabase(database).db, "outbound_message_progress")).toBe(
      false,
    );
    recorder.recordMessage(messageEvent("message.outbound.queued"));
    expect(tableExists(openOpenClawStateDatabase(database).db, "outbound_message_progress")).toBe(
      false,
    );

    config = { logging: { audit: { messages: "all" } } };
    recorder.recordMessage(messageEvent("message.outbound.queued"));
    recorder.recordMessage(messageEvent("message.outbound.platform-started"));
    recorder.recordMessage(messageEvent("message.outbound.finished"));
    config = { logging: { audit: { enabled: false, messages: "all" } } };
    recorder.recordMessage({ ...messageEvent("message.outbound.finished"), sourceId: "disabled" });
    await recorder.stop();

    const { db } = openOpenClawStateDatabase(database);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get()).toEqual({
      count: 2,
    });
    expect(db.prepare("SELECT action FROM audit_events").all()).toEqual([
      { action: "message.outbound.finished" },
    ]);
  });

  it.each(["cold", "ready"] as const)(
    "flushes the %s owner's audit FIFO after a competing writer releases its lock",
    async (mode) => {
      const database = databaseFixture();
      const opened = openOpenClawStateDatabase(database);
      recordAuditEventInDatabase(input(), { ...database, database: opened });
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      const contender = new DatabaseSync(opened.path);
      const lock = () => contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      if (mode === "cold") {
        lock();
      }
      const { writer, errors } = startWriter(database);
      if (mode === "ready") {
        await writer.ready;
        lock();
      }
      try {
        for (const runId of ["contention-first", "contention-second"]) {
          expect(writer.record({ ...input(), sourceId: runId, runId })).toBe(true);
        }
        await setImmediate();
        expect(contender.isTransaction).toBe(true);
      } finally {
        try {
          try {
            contender.exec("ROLLBACK");
          } finally {
            contender.close();
          }
        } finally {
          await writer.ready;
          await writer.stop();
        }
      }
      expect(errors).toEqual([]);
      expect(await runIds(database)).toEqual(["contention-second", "contention-first", "run-1"]);
    },
  );

  it("keeps the shared queue nonblocking under a held write lock and flushes before stop", async () => {
    const database = databaseFixture();
    recordAuditEventInDatabase(input(), {
      ...database,
      database: openOpenClawStateDatabase(database),
    });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const { writer, errors } = startWriter(database, 3);
    await writer.ready;
    const { db, path } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
    db.exec("DELETE FROM audit_identity_keys;");
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
    const admittedAt = Date.now();

    try {
      expect(writer.record({ ...input(), sourceId: "run-2:1:started", runId: "run-2" })).toBe(true);
      expect(
        enqueueExecutionIdentityContextAtAdmission(
          executionIdentityFacts("held-lock-run", {
            ingress: {
              kind: "local-cli",
              boundary: "agent-command.local",
              state: "present",
              rawSourceRef: "raw-ingress-secret",
            },
            invoker: {
              state: "present",
              kind: "local-account",
              rawPrincipalRef: "raw-principal-secret",
            },
          }),
          {
            enabled: true,
            contextId: "held-lock-context",
            executionId: "held-lock-execution",
            now: admittedAt,
            runtimeInstanceId: "raw-runtime-secret",
          },
        ),
      ).toEqual({
        candidateContextId: "held-lock-context",
        candidateExecutionId: "held-lock-execution",
        accepted: true,
      });
      const receipt = {
        ...decisionReceipt(),
        contextId: "held-lock-context",
        executionId: "held-lock-execution",
        runId: "held-lock-run",
        occurredAt: admittedAt,
      };
      expect(writer.recordExecutionDecision(receipt)).toBe(true);
      await setImmediate();
      expect(contender.isTransaction).toBe(true);
      expect(
        writer.recordExecutionIdentity({
          kind: "retry-reference",
          token: createExecutionIdentityAdmissionToken("queue-full-run", {
            contextId: "queue-full-context",
            executionId: "queue-full-execution",
            now: admittedAt,
          }),
        }),
      ).toBe(false);
      expect(errors).toEqual(["audit event queue is full (3); dropping metadata"]);
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'execution_identity_contexts'")
          .get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_identity_keys").get()).toEqual({
        count: 0,
      });
      let stopped = false;
      void writer.stop().then(() => {
        stopped = true;
      });
      await setImmediate();
      expect(stopped).toBe(false);
      expect(writer.record(input())).toBe(false);
    } finally {
      try {
        contender.exec("ROLLBACK");
        contender.close();
      } finally {
        clearSink();
        await writer.stop();
      }
    }

    expect(errors).toEqual(["audit event queue is full (3); dropping metadata"]);
    expect((await listAuditEvents({ database, limit: 10 })).events).toHaveLength(2);
    expect(
      pageExecutionDecisionFactsForContextInDatabase(openOpenClawStateDatabase(database).db, {
        context: {
          contextId: "held-lock-context",
          executionId: "held-lock-execution",
          runId: "held-lock-run",
        },
        limit: 10,
        now: admittedAt,
      }).receipts,
    ).toHaveLength(1);
    expect(
      await inspectExecutionIdentityRun(
        { runId: "held-lock-run" },
        { ...database, now: admittedAt },
      ),
    ).toMatchObject({
      identity: {
        state: "present",
        context: {
          contextId: "held-lock-context",
          executionId: "held-lock-execution",
          runId: "held-lock-run",
          createdAt: admittedAt,
          ingress: {
            kind: "local-cli",
            boundary: "agent-command.local",
            state: "present",
          },
          runtimeInstance: { kind: "embedded", state: "present" },
        },
      },
    });
    const persisted = db
      .prepare("SELECT context_json FROM execution_identity_contexts WHERE run_id = ?")
      .get("held-lock-run") as { context_json: string };
    for (const raw of ["raw-ingress-secret", "raw-principal-secret", "raw-runtime-secret"]) {
      expect(persisted.context_json).not.toContain(raw);
      expect(JSON.stringify(errors)).not.toContain(raw);
    }
  });

  it("persists owned unknown and omits inherited evidence through the queue clone boundary", async () => {
    const database = databaseFixture();
    const { writer, errors } = startWriter(database);
    const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
    const admittedAt = Date.now();
    const inheritedRefs = {
      invoker: "raw-inherited-principal",
      applicableGrants: "raw-inherited-grant",
      assurance: "raw-inherited-assurance",
      rawSourceRef: "raw-inherited-source",
    } as const;
    const prior = new Map(
      Object.keys(inheritedRefs).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(Object.prototype, key),
      ]),
    );
    let inheritedInvokerReads = 0;

    try {
      try {
        defineObjectPrototypeProperties({
          invoker: {
            configurable: true,
            enumerable: false,
            get: () => {
              inheritedInvokerReads += 1;
              return {
                state: "present",
                kind: "local-account",
                rawPrincipalRef: inheritedRefs.invoker,
              };
            },
          },
          applicableGrants: {
            configurable: true,
            enumerable: false,
            value: [{ rawGrantRef: inheritedRefs.applicableGrants, state: "present" }],
          },
          assurance: {
            configurable: true,
            enumerable: false,
            value: [
              {
                kind: "other",
                rawEvidenceRef: inheritedRefs.assurance,
                strength: "self-asserted",
              },
            ],
          },
          rawSourceRef: {
            configurable: true,
            enumerable: false,
            value: inheritedRefs.rawSourceRef,
          },
        });
        expect(
          enqueueExecutionIdentityContextAtAdmission(executionIdentityFacts("absent-invoker-run"), {
            enabled: true,
            contextId: "absent-invoker-context",
            executionId: "absent-invoker-execution",
            now: admittedAt,
            runtimeInstanceId: "private-absent-runtime-reference",
          }),
        ).toEqual({
          candidateContextId: "absent-invoker-context",
          candidateExecutionId: "absent-invoker-execution",
          accepted: true,
        });
      } finally {
        for (const [key, descriptor] of prior) {
          if (descriptor) {
            defineObjectPrototypeProperties({ [key]: descriptor });
          } else {
            delete (Object.prototype as Record<string, unknown>)[key];
          }
        }
      }

      expect(
        enqueueExecutionIdentityContextAtAdmission(
          executionIdentityFacts("unknown-invoker-run", {
            invoker: { state: "unknown" },
          }),
          {
            enabled: true,
            contextId: "unknown-invoker-context",
            executionId: "unknown-invoker-execution",
            now: admittedAt + 1,
            runtimeInstanceId: "private-unknown-runtime-reference",
          },
        ),
      ).toEqual({
        candidateContextId: "unknown-invoker-context",
        candidateExecutionId: "unknown-invoker-execution",
        accepted: true,
      });
    } finally {
      clearSink();
      await writer.ready;
      await writer.stop();
    }

    const absentInspection = await inspectExecutionIdentityRun(
      { executionId: "absent-invoker-execution" },
      { ...database, now: admittedAt + 1 },
    );
    const unknownInspection = await inspectExecutionIdentityRun(
      { executionId: "unknown-invoker-execution" },
      { ...database, now: admittedAt + 1 },
    );
    expect(inheritedInvokerReads).toBe(0);
    expect(errors).toEqual([]);
    expect(absentInspection).toMatchObject({
      identity: {
        state: "present",
        context: {
          invoker: { state: "absent" },
          ingress: { state: "present" },
          applicableGrants: [],
          assurance: [{ kind: "runtime-binding", strength: "boundary-verified" }],
          coverageState: "unattributed",
          missingEvidence: ["invoker.principal"],
        },
      },
      coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
    });
    expect(unknownInspection).toMatchObject({
      identity: {
        state: "present",
        context: {
          invoker: { state: "unknown" },
          coverageState: "unknown",
          missingEvidence: ["invoker.principal"],
        },
      },
      coverage: { state: "unknown", missingEvidence: ["invoker.principal"] },
    });
    const persisted = openOpenClawStateDatabase(database)
      .db.prepare(
        "SELECT context_json FROM execution_identity_contexts WHERE execution_id IN (?, ?) ORDER BY execution_id",
      )
      .all("absent-invoker-execution", "unknown-invoker-execution");
    const publicAndStored = JSON.stringify({
      errors,
      absentInspection,
      unknownInspection,
      persisted,
    });
    for (const rawRef of Object.values(inheritedRefs)) {
      expect(publicAndStored).not.toContain(rawRef);
    }
    expect(publicAndStored).not.toContain("private-absent-runtime-reference");
    expect(publicAndStored).not.toContain("private-unknown-runtime-reference");
  });

  it("prunes expired identity contexts before preserving exact-envelope conflicts", async () => {
    const database = databaseFixture();
    persistExecutionIdentityAdmissionEnvelope(envelopeFor("expired-before-startup", { now: 0 }), {
      ...database,
      now: 0,
    });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const { writer, errors } = startWriter(database);
    await writer.ready;
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
        .get(),
    ).toEqual({ count: 0 });
    const admittedAt = Date.now();
    const identityOptions = {
      contextId: "ordered-context",
      executionId: "ordered-execution",
      now: admittedAt,
    };
    const original = envelopeFor("ordered-run", identityOptions, {
      ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
    });
    const factConflict = envelopeFor("ordered-run", identityOptions, {
      agentId: "other",
      ingress: {
        kind: "local-cli",
        boundary: "agent-command.local",
        state: "present",
        rawSourceRef: "raw-conflict-source",
      },
      invoker: {
        state: "present",
        kind: "local-account",
        rawPrincipalRef: "raw-conflict-principal",
      },
    });
    const contextIdConflict = { ...original, contextId: "conflicting-context" };
    const createdAtConflict = { ...original, createdAt: admittedAt + 1 };

    const startedAt = performance.now();
    expect(writer.recordExecutionIdentity(captureWork(original))).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(original))).toBe(true);
    expect(
      writer.recordExecutionIdentity({
        kind: "retry-reference",
        token: createExecutionIdentityAdmissionToken(original.runId, identityOptions),
      }),
    ).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(contextIdConflict))).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(createdAtConflict))).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(factConflict))).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(250);
    await writer.stop();

    expect(errors).toEqual([
      "audit execution identity context conflict",
      "audit execution identity context conflict",
      "audit execution identity context conflict",
    ]);
    expect(
      await inspectExecutionIdentityRun({ runId: "ordered-run" }, { ...database, now: admittedAt }),
    ).toMatchObject({
      identity: {
        state: "present",
        context: {
          contextId: "ordered-context",
          agentDefinition: { definitionRef: "main" },
          ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
        },
      },
    });
    const persisted = openOpenClawStateDatabase(database)
      .db.prepare("SELECT context_json FROM execution_identity_contexts WHERE run_id = ?")
      .get("ordered-run") as { context_json: string };
    for (const raw of ["raw-conflict-source", "raw-conflict-principal"]) {
      expect(persisted.context_json).not.toContain(raw);
      expect(JSON.stringify(errors)).not.toContain(raw);
    }
  });

  it("keeps schema and insert failures off the admission path", async () => {
    const envelope = envelopeFor("nonblocking-failure-run");

    const schemaDatabase = databaseFixture();
    openOpenClawStateDatabase(schemaDatabase).db.exec(`
      CREATE VIEW execution_identity_contexts AS
      SELECT 'context' AS context_id, 'run' AS run_id, 0 AS created_at,
             'unattributed' AS coverage_state, 2 AS context_bytes, '{}' AS context_json;
    `);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const { writer: schemaWriter, errors: schemaErrors } = startWriter(schemaDatabase);
    const schemaStartedAt = performance.now();
    expect(schemaWriter.recordExecutionIdentity(captureWork(envelope))).toBe(true);
    expect(performance.now() - schemaStartedAt).toBeLessThan(250);
    await schemaWriter.ready;
    await schemaWriter.stop();
    expect(schemaErrors).toContain("audit execution identity persistence failed");

    const insertDatabase = databaseFixture();
    persistExecutionIdentityAdmissionEnvelope(
      envelopeFor("insert-failure-setup", { runtimeInstanceId: "runtime-setup" }),
      insertDatabase,
    );
    const insertDb = openOpenClawStateDatabase(insertDatabase).db;
    insertDb.exec(`
      CREATE TRIGGER reject_identity_insert
      BEFORE INSERT ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'raw-trigger-secret');
      END;
    `);
    const { writer: insertWriter, errors: insertErrors } = startWriter(insertDatabase);
    const insertStartedAt = performance.now();
    expect(insertWriter.recordExecutionIdentity(captureWork(envelope))).toBe(true);
    expect(performance.now() - insertStartedAt).toBeLessThan(250);
    await insertWriter.ready;
    await insertWriter.stop();
    expect(insertErrors).toContain("audit execution identity persistence failed");
    expect(JSON.stringify(insertErrors)).not.toContain("raw-trigger-secret");
    insertDb.exec("DROP TRIGGER reject_identity_insert;");
    expect(
      (await inspectExecutionIdentityRun({ runId: envelope.runId }, insertDatabase)).identity,
    ).toMatchObject({ state: "unknown", reasonCode: "run_not_found" });
  });

  it("keeps malformed, serialization, and key failures nonblocking and redaction-safe", async () => {
    const database = databaseFixture();
    const rawSecret = "raw-worker-message-secret";
    persistExecutionIdentityAdmissionEnvelope(envelopeFor("before-key-loss"), database);
    openOpenClawStateDatabase(database).db.exec("DELETE FROM audit_identity_keys;");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const { writer, errors } = startWriter(database);
    const unserializable = {
      ...envelopeFor("serialization-run"),
      ingress: {
        kind: "local-cli",
        boundary: "agent-command.local",
        state: "present",
        rawSourceRef: () => rawSecret,
      },
    };
    expect(writer.recordExecutionIdentity(captureWork(unserializable as never))).toBe(false);
    expect(writer.recordExecutionIdentity({ rawSecret } as never)).toBe(true);
    const invalidUnknown = {
      ...envelopeFor("invalid-unknown-run"),
      invoker: { state: "unknown", rawPrincipalRef: rawSecret },
    };
    expect(writer.recordExecutionIdentity(captureWork(invalidUnknown as never))).toBe(true);
    expect(
      writer.recordExecutionIdentity(
        captureWork(envelopeFor("after-key-loss", { runtimeInstanceId: rawSecret })),
      ),
    ).toBe(true);
    await writer.ready;
    await writer.stop();
    expect(errors).toContain("audit execution identity envelope could not be queued");
    expect(errors).toContain("audit execution identity envelope rejected");
    expect(errors).toContain("audit execution identity key unavailable");
    expect(JSON.stringify(errors)).not.toContain(rawSecret);
    expect(
      (await inspectExecutionIdentityRun({ runId: "after-key-loss" }, database)).identity,
    ).toMatchObject({ state: "unknown", reasonCode: "run_not_found" });
  });
});
