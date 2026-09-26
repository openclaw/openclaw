// Shared receipt evidence helpers and admitted webhook proof for the real QA Gateway.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { validateExecutionIdentityContextV1 } from "../../../../packages/gateway-protocol/src/audit-run-validators.js";
import { lazyCompile } from "../../../../packages/gateway-protocol/src/protocol-validator.js";
import {
  AuditRunInspectResultSchema,
  type AuditRunInspectResult,
  type ExecutionIdentityContextV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";

export type ExactOwnerRow = {
  context_id: string;
  execution_id: string;
  run_id: string;
  status: string;
};
type OwnerDisplayProducer = "cron-lifecycle" | "task-lifecycle" | "flow-lifecycle";
type ContextRow = {
  context_id: string;
  execution_id: string;
  run_id: string;
  context_json: string;
};

export function hasSqliteColumns(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
): boolean {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) {
    return false;
  }
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  return columns.every((column) => present.has(column));
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`${label} was not JSON: ${formatErrorMessage(error)}`, { cause: error });
  }
}

const validateAuditInspection = lazyCompile(AuditRunInspectResultSchema);

export function parseAuditInspection(raw: string, label: string): AuditRunInspectResult {
  const value = parseJson(raw, label);
  if (!validateAuditInspection(value)) {
    throw new Error(`${label} did not match the audit inspection contract`);
  }
  return value;
}

export function stateDatabasePath(gateway: QaGatewayChild): string {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  return path.join(stateDir, "state", "openclaw.sqlite");
}

export function countExecutionContexts(gateway: QaGatewayChild): number {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    if (!hasSqliteColumns(db, "execution_identity_contexts", ["context_id"])) {
      return 0;
    }
    const row = db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

function readExecutionContexts(gateway: QaGatewayChild): ContextRow[] {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    if (!hasSqliteColumns(db, "execution_identity_contexts", ["context_json"])) {
      return [];
    }
    return db
      .prepare(
        "SELECT context_id, execution_id, run_id, context_json FROM execution_identity_contexts ORDER BY execution_id",
      )
      .all() as ContextRow[];
  } finally {
    db.close();
  }
}

function requirePrivateSentinelsAbsent(
  text: string,
  sentinels: readonly string[],
  surface: string,
) {
  if (sentinels.some((sentinel) => text.includes(sentinel))) {
    throw new Error(`${surface} leaked a private webhook or prompt sentinel`);
  }
}

function requireWebhookContext(context: ExecutionIdentityContextV1) {
  if (
    context.ingress.kind !== "webhook" ||
    context.ingress.boundary !== "gateway.hooks.agent" ||
    context.ingress.state !== "present" ||
    !/^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u.test(context.ingress.sourceRef ?? "")
  ) {
    throw new Error("admitted mapped webhook omitted its pseudonymized ingress source");
  }
  if (
    JSON.stringify(context.invoker) !== JSON.stringify({ state: "absent" }) ||
    context.coverageState !== "unattributed" ||
    !context.missingEvidence.includes("invoker.principal")
  ) {
    throw new Error("mapped webhook source or shared authentication became invoker evidence");
  }
}

function requireWebhookIdentity(result: AuditRunInspectResult, row: ContextRow) {
  if (result.identity.state !== "present") {
    throw new Error("mapped webhook inspection did not retain its exact persisted context");
  }
  const context = result.identity.context;
  if (
    JSON.stringify(context) !== row.context_json ||
    context.contextId !== row.context_id ||
    context.executionId !== row.execution_id ||
    context.runId !== row.run_id
  ) {
    throw new Error("mapped webhook inspection did not retain its exact persisted context");
  }
  requireWebhookContext(context);
  const admission = result.decisionDisplays.find(
    (display) =>
      display.provenance.state === "verified" && display.provenance.producer === "run-admission",
  );
  if (
    admission?.enforcement.coverageState !== "unattributed" ||
    admission.decision.outcome !== "not-applicable"
  ) {
    throw new Error("mapped webhook source or shared authentication became invoker evidence");
  }
  return context;
}

export function readCliOwnerRows(
  gateway: QaGatewayChild,
  runId: string,
): { task: ExactOwnerRow } | undefined {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    if (
      !hasSqliteColumns(db, "execution_identity_contexts", ["context_id", "execution_id"]) ||
      !hasSqliteColumns(db, "execution_owner_lifecycle_bindings", [
        "owner_kind",
        "owner_id",
        "context_id",
        "execution_id",
      ]) ||
      !hasSqliteColumns(db, "task_runs", ["task_id"])
    ) {
      return undefined;
    }
    const task = db
      .prepare(
        `SELECT binding.context_id, binding.execution_id, context.run_id, task.status
         FROM task_runs AS task
         JOIN execution_owner_lifecycle_bindings AS binding
           ON binding.owner_kind = 'task' AND binding.owner_id = task.task_id
         JOIN execution_identity_contexts AS context
           ON context.context_id = binding.context_id
          AND context.execution_id = binding.execution_id
         WHERE task.runtime = 'cli' AND task.run_id = ? AND task.ended_at IS NOT NULL
         LIMIT 1`,
      )
      .get(runId) as ExactOwnerRow | undefined;
    return task ? { task } : undefined;
  } finally {
    db.close();
  }
}

export async function waitFor<T>(label: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function requireOwnerDisplay(result: AuditRunInspectResult, producer: OwnerDisplayProducer) {
  const receipt = result.decisionDisplays.find(
    (candidate) =>
      candidate.provenance.state === "verified" && candidate.provenance.producer === producer,
  );
  if (
    !receipt ||
    receipt.enforcement.coverageState !== "attribution-only" ||
    receipt.decision.outcome !== "not-applicable"
  ) {
    throw new Error(`inspection omitted exact attribution-only ${producer} display`);
  }
  return receipt;
}

export async function inspectExecution(params: {
  gateway: QaGatewayChild;
  executionId: string;
  producers: OwnerDisplayProducer[];
  privateSentinels: string[];
}) {
  const jsonRaw = await params.gateway.runCli([
    "audit",
    "--execution",
    params.executionId,
    "--explain",
    "--json",
  ]);
  const json = parseAuditInspection(jsonRaw, "owner lifecycle inspection");
  for (const producer of params.producers) {
    requireOwnerDisplay(json, producer);
  }
  requirePrivateSentinelsAbsent(jsonRaw, params.privateSentinels, "JSON inspection");
  const human = await params.gateway.runCli([
    "audit",
    "--execution",
    params.executionId,
    "--explain",
  ]);
  requirePrivateSentinelsAbsent(human, params.privateSentinels, "human inspection");
  for (const producer of params.producers) {
    if (!human.includes(`Display producer: ${producer}`)) {
      throw new Error(`human inspection omitted ${producer}`);
    }
  }
  return { json, jsonRaw, human };
}

export function createMappedWebhookProof(hookToken: string) {
  const mappingId = `PRIVATE-MAPPING-${randomUUID()}`;
  const createRequest = () => ({
    requestId: `PRIVATE-REQUEST-${randomUUID()}`,
    body: `PRIVATE-WEBHOOK-BODY-${randomUUID()}`,
  });
  const webhookRequests = [createRequest(), createRequest()];
  const restartRequest = createRequest();
  const webhookSentinels = [
    mappingId,
    ...[...webhookRequests, restartRequest].flatMap(({ requestId, body }) => [requestId, body]),
  ];
  const admitRequest = async (
    gateway: QaGatewayChild,
    request: ReturnType<typeof createRequest>,
  ) => {
    const before = new Set(readExecutionContexts(gateway).map((row) => row.execution_id));
    const response = await fetch(`${gateway.baseUrl}/hooks/admitted`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hookToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": request.requestId,
        "X-Request-Id": request.requestId,
      },
      body: JSON.stringify({ value: request.body }),
    });
    const accepted = parseJson(await response.text(), "mapped webhook admission");
    if (
      response.status !== 200 ||
      !isRecord(accepted) ||
      accepted.ok !== true ||
      typeof accepted.runId !== "string" ||
      !accepted.runId
    ) {
      throw new Error(`mapped webhook admission returned HTTP ${response.status}`);
    }
    // The HTTP dispatch id differs from the inner admitted run id. One POST
    // at a time binds the new context without guessing from either id.
    const row = await waitFor("one admitted webhook context", () => {
      const added = readExecutionContexts(gateway).filter(
        (candidate) => !before.has(candidate.execution_id),
      );
      if (added.length > 1) {
        throw new Error("one mapped webhook allocated multiple execution contexts");
      }
      return added[0];
    });
    const persistedContext = parseJson(row.context_json, "persisted webhook context");
    if (!validateExecutionIdentityContextV1(persistedContext)) {
      throw new Error("persisted webhook context did not match the execution identity contract");
    }
    requireWebhookContext(persistedContext);
    // Hooks invoke the isolated runner directly; only scheduled cron owns task rows.
    // Observe the admitted runner's terminal event before inspection or replacement.
    const completed = (await gateway.call(
      "agent.wait",
      { runId: row.run_id, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    )) as { runId: string; status: string };
    if (completed.runId !== row.run_id || completed.status !== "ok") {
      throw new Error(`admitted mapped webhook did not complete successfully: ${completed.status}`);
    }
    const inspection = await inspectExecution({
      gateway,
      executionId: row.execution_id,
      producers: [],
      privateSentinels: webhookSentinels,
    });
    const context = requireWebhookIdentity(inspection.json, row);
    for (const text of [
      "Invoker [absent]",
      "Ingress [present]",
      "webhook at gateway.hooks.agent",
      context.ingress.sourceRef!,
    ]) {
      if (!inspection.human.includes(text)) {
        throw new Error("human inspection omitted mapped webhook identity evidence");
      }
    }
    return { row, context, inspection };
  };
  return {
    mapping: {
      id: mappingId,
      match: { path: "admitted" },
      action: "agent" as const,
      messageTemplate: "{{payload.value}}: reply WEBHOOK-DONE",
      deliver: false,
      wakeMode: "next-heartbeat" as const,
    },
    async admit(gateway: QaGatewayChild) {
      const webhookProofs: Array<Awaited<ReturnType<typeof admitRequest>>> = [];
      for (const request of webhookRequests) {
        webhookProofs.push(await admitRequest(gateway, request));
      }
      const [firstWebhook, secondWebhook] = webhookProofs;
      if (
        !firstWebhook ||
        !secondWebhook ||
        firstWebhook.context.ingress.sourceRef !== secondWebhook.context.ingress.sourceRef ||
        firstWebhook.row.context_id === secondWebhook.row.context_id
      ) {
        throw new Error(
          "one mapping did not retain a stable source across distinct webhook requests",
        );
      }
      requirePrivateSentinelsAbsent(
        JSON.stringify(readExecutionContexts(gateway)),
        webhookSentinels,
        "persisted execution contexts",
      );

      return {
        contexts: webhookProofs.map(({ context }) => ({
          contextId: context.contextId,
          executionId: context.executionId,
          ingress: context.ingress,
          invoker: context.invoker,
          coverageState: context.coverageState,
        })),
        inspections: webhookProofs.map(({ inspection }) => inspection.json),
        async verifyAfterRestart(replacementGateway: QaGatewayChild) {
          const restarted = await admitRequest(replacementGateway, restartRequest);
          if (
            webhookProofs.some(
              ({ row, context }) =>
                context.ingress.sourceRef !== restarted.context.ingress.sourceRef ||
                row.context_id === restarted.row.context_id ||
                row.execution_id === restarted.row.execution_id,
            )
          ) {
            throw new Error(
              "new webhook admission changed its mapping source across Gateway replacement",
            );
          }
          const webhooksAfter = [];
          const persistedAfter = readExecutionContexts(replacementGateway);
          for (const proof of webhookProofs) {
            const row = persistedAfter.find(
              (candidate) => candidate.execution_id === proof.row.execution_id,
            );
            if (!row || row.context_json !== proof.row.context_json) {
              throw new Error("persisted webhook context changed across Gateway replacement");
            }
            const inspection = await inspectExecution({
              gateway: replacementGateway,
              executionId: row.execution_id,
              producers: [],
              privateSentinels: webhookSentinels,
            });
            requireWebhookIdentity(inspection.json, row);
            if (inspection.human !== proof.inspection.human) {
              throw new Error("human webhook inspection changed across Gateway replacement");
            }
            webhooksAfter.push(inspection.json);
          }
          requirePrivateSentinelsAbsent(
            JSON.stringify(persistedAfter),
            webhookSentinels,
            "persisted execution contexts after restart",
          );
          const auditLogLines = (
            await Promise.all(
              ["gateway.stdout.log", "gateway.stderr.log"].map((file) =>
                fs.readFile(path.join(replacementGateway.tempRoot, file), "utf8"),
              ),
            )
          )
            .join("\n")
            .split(/\r?\n/u)
            .filter((line) => /\baudit\b|execution identity|execution decision/iu.test(line));
          requirePrivateSentinelsAbsent(auditLogLines.join("\n"), webhookSentinels, "audit logs");
          return {
            inspections: webhooksAfter,
            admittedContext: {
              contextId: restarted.context.contextId,
              executionId: restarted.context.executionId,
              ingress: restarted.context.ingress,
              invoker: restarted.context.invoker,
              coverageState: restarted.context.coverageState,
            },
            auditLogLinesChecked: auditLogLines.length,
          };
        },
      };
    },
  };
}
