// QA Lab producer proves cron receipts and admitted execution identity through a real mock Gateway.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import {
  createQaGatewayChild,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  countExecutionContexts,
  createMappedWebhookProof,
  hasSqliteColumns,
  inspectExecution,
  parseAuditInspection,
  requireOwnerDisplay,
  stateDatabasePath,
  waitFor,
  type ExactOwnerRow,
} from "./autonomous-task-lifecycle-receipts.fixtures.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const SCENARIO_ID = "autonomous-task-lifecycle-receipts";
const SNAPSHOT_FILE = `${SCENARIO_ID}-summary.json`;
const HOOK_TOKEN = "qa-autonomous-hook-token";

type ProducerOptions = { artifactBase: string; repoRoot: string };
type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};
function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readCronOwnerRows(
  gateway: QaGatewayChild,
  jobId: string,
): { cron: ExactOwnerRow } | undefined {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    if (
      !hasSqliteColumns(db, "execution_identity_contexts", ["context_id", "execution_id"]) ||
      !hasSqliteColumns(db, "execution_owner_lifecycle_bindings", [
        "owner_kind",
        "owner_id",
        "context_id",
        "execution_id",
      ])
    ) {
      return undefined;
    }
    const cron = db
      .prepare(
        `SELECT binding.context_id, binding.execution_id, context.run_id, receipt.status
         FROM cron_run_receipts AS receipt
         JOIN execution_owner_lifecycle_bindings AS binding
           ON binding.owner_kind = 'cron' AND binding.owner_id = receipt.receipt_id
         JOIN execution_identity_contexts AS context
           ON context.context_id = binding.context_id
          AND context.execution_id = binding.execution_id
         WHERE receipt.job_id = ? AND receipt.status != 'running'
         ORDER BY receipt.started_at_ms DESC LIMIT 1`,
      )
      .get(jobId) as ExactOwnerRow | undefined;
    return cron ? { cron } : undefined;
  } finally {
    db.close();
  }
}

function readCronOwnerBindingDiagnostic(gateway: QaGatewayChild, jobId: string): unknown {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    return {
      cron: db
        .prepare(
          `SELECT binding.context_id, binding.execution_id, receipt.status
           FROM cron_run_receipts AS receipt
           JOIN execution_owner_lifecycle_bindings AS binding
             ON binding.owner_kind = 'cron' AND binding.owner_id = receipt.receipt_id
           WHERE receipt.job_id = ?
           ORDER BY receipt.started_at_ms DESC LIMIT 1`,
        )
        .get(jobId),
    };
  } finally {
    db.close();
  }
}

function readAgentIdentity(
  gateway: QaGatewayChild,
  runId: string,
): Omit<ExactOwnerRow, "status"> | undefined {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT context_id, execution_id, run_id FROM execution_identity_contexts WHERE run_id = ?",
      )
      .get(runId) as Omit<ExactOwnerRow, "status"> | undefined;
  } finally {
    db.close();
  }
}

function requireExecutionIdentity(
  result: Awaited<ReturnType<typeof inspectExecution>>["json"],
  executionId: string,
): void {
  if (result.identity.state !== "present" || result.identity.context.executionId !== executionId) {
    throw new Error("inspection omitted the exact admitted execution identity");
  }
}

async function runProof(options: ProducerOptions): Promise<string> {
  const mock = await startQaMockOpenAiServer();
  const gatewayOwner = createQaGatewayChild();
  let gateway: QaGatewayChild | undefined;
  const webhook = createMappedWebhookProof(HOOK_TOKEN);
  try {
    gateway = await gatewayOwner.start({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      command: {
        executablePath: process.execPath,
        argsPrefix: [path.join(options.repoRoot, "dist/index.js")],
        cwd: options.repoRoot,
        usePackagedPlugins: true,
      },
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mutateConfig: (config) => ({
        ...config,
        logging: {
          ...config.logging,
          audit: { ...config.logging?.audit, enabled: true, executionIdentity: true },
        },
        hooks: {
          enabled: true,
          token: HOOK_TOKEN,
          mappings: [
            webhook.mapping,
            {
              id: "qa-suppressed-source",
              match: { path: "suppressed" },
              action: "agent",
              messageTemplate: "PRIVATE-SUPPRESSED-{{payload.value}}",
              transform: { module: "suppress.mjs" },
            },
          ],
        },
      }),
    });
    const transformDir = path.join(path.dirname(gateway.configPath), "hooks", "transforms");
    await fs.mkdir(transformDir, { recursive: true });
    await fs.writeFile(
      path.join(transformDir, "suppress.mjs"),
      "export default function suppress() { return null; }\n",
      "utf8",
    );

    const contextsBeforeSuppression = countExecutionContexts(gateway);
    const suppression = await fetch(`${gateway.baseUrl}/hooks/suppressed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HOOK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: randomUUID() }),
    });
    if (suppression.status !== 204) {
      throw new Error(`mapped suppression returned HTTP ${suppression.status}`);
    }
    await delay(100);
    if (countExecutionContexts(gateway) !== contextsBeforeSuppression) {
      throw new Error("pre-admission mapping suppression allocated execution identity");
    }

    const webhookProof = await webhook.admit(gateway);

    const cronSentinel = `PRIVATE-CRON-${randomUUID()}`;
    const cronJob = (await gateway.call("cron.add", {
      name: "QA autonomous receipt",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: `${cronSentinel}: reply CRON-DONE` },
      delivery: { mode: "none" },
    })) as { id: string };
    await gateway.call("cron.run", { id: cronJob.id, mode: "force" });
    let cronRows: { cron: ExactOwnerRow };
    try {
      cronRows = await waitFor("terminal cron exact binding", () =>
        readCronOwnerRows(gateway!, cronJob.id),
      );
    } catch (error) {
      throw new Error(
        `${formatErrorMessage(error)}; owner rows=${JSON.stringify(readCronOwnerBindingDiagnostic(gateway, cronJob.id))}; gateway logs=${gateway.logs()}`,
        { cause: error },
      );
    }
    const cronInspection = await inspectExecution({
      gateway,
      executionId: cronRows.cron.execution_id,
      producers: ["cron-lifecycle"],
      privateSentinels: [cronSentinel],
    });
    requireExecutionIdentity(cronInspection.json, cronRows.cron.execution_id);
    const cronCursorPage = parseAuditInspection(
      await gateway.runCli([
        "audit",
        "--execution",
        cronRows.cron.execution_id,
        "--explain",
        "--cursor",
        "c:0:0",
        "--limit",
        "1",
        "--json",
      ]),
      "cron cursor page",
    );
    requireOwnerDisplay(cronCursorPage, "cron-lifecycle");

    const taskSentinel = `PRIVATE-TASK-${randomUUID()}`;
    const cliRunId = `qa-cli-${randomUUID()}`;
    const accepted = (await gateway.call(
      "agent",
      {
        sessionKey: "agent:qa:main",
        message: `${taskSentinel}: reply TASK-DONE`,
        deliver: false,
        idempotencyKey: cliRunId,
      },
      { expectFinal: false },
    )) as { runId: string; status: string };
    const terminal = (await gateway.call(
      "agent.wait",
      { runId: accepted.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    )) as { status: string };
    if (terminal.status !== "ok") {
      throw new Error(`Agent did not complete: ${JSON.stringify(terminal)}`);
    }
    const agentIdentity = await waitFor("admitted agent execution identity", () =>
      readAgentIdentity(gateway!, accepted.runId),
    );
    const taskInspection = await inspectExecution({
      gateway,
      executionId: agentIdentity.execution_id,
      producers: [],
      privateSentinels: [taskSentinel],
    });

    requireExecutionIdentity(taskInspection.json, agentIdentity.execution_id);
    const beforeRestart = JSON.stringify({
      cron: cronInspection.json,
      task: taskInspection.json,
      webhooks: webhookProof.inspections,
    });
    await gateway.restartAfterStateMutation(async () => {});
    const cronAfter = await inspectExecution({
      gateway,
      executionId: cronRows.cron.execution_id,
      producers: ["cron-lifecycle"],
      privateSentinels: [cronSentinel],
    });
    requireExecutionIdentity(cronAfter.json, cronRows.cron.execution_id);
    const taskAfter = await inspectExecution({
      gateway,
      executionId: agentIdentity.execution_id,
      producers: [],
      privateSentinels: [taskSentinel],
    });
    requireExecutionIdentity(taskAfter.json, agentIdentity.execution_id);
    const webhooksAfter = await webhookProof.verifyAfterRestart(gateway);
    const afterRestart = JSON.stringify({
      cron: cronAfter.json,
      task: taskAfter.json,
      webhooks: webhooksAfter.inspections,
    });
    if (afterRestart !== beforeRestart) {
      throw new Error("owner lifecycle JSON changed across Gateway replacement");
    }

    const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
    let ownerDuplicateCount = 0;
    try {
      if (hasSqliteColumns(db, "execution_decision_facts", ["owner"])) {
        ownerDuplicateCount = (
          db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM execution_decision_facts
               WHERE owner = 'cron_run_receipts'`,
            )
            .get() as { count: number }
        ).count;
      }
    } finally {
      db.close();
    }
    if (ownerDuplicateCount !== 0) {
      throw new Error("owner lifecycle rows were duplicated into execution_decision_facts");
    }

    const snapshotPath = path.join(options.artifactBase, SNAPSHOT_FILE);
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      snapshotPath,
      `${JSON.stringify(
        {
          suppression: { httpStatus: 204, identityAllocation: 0 },
          webhooks: webhookProof.contexts,
          webhookAdmittedAfterRestart: webhooksAfter.admittedContext,
          cron: {
            contextId: cronRows.cron.context_id,
            executionId: cronRows.cron.execution_id,
            statuses: [cronRows.cron.status],
            displayProducers: ["cron-lifecycle"],
          },
          task: {
            contextId: agentIdentity.context_id,
            executionId: agentIdentity.execution_id,
            statuses: [terminal.status],
            displayProducers: [],
          },
          cursorCompatibility: { cronPrefixAccepted: true },
          genericDuplicateAbsent: true,
          byteEquivalentAfterRestart: true,
          privacy: {
            cronPromptAbsent: true,
            taskPromptAbsent: true,
            webhookMappingRequestAndBodyAbsent: true,
            auditLogLinesChecked: webhooksAfter.auditLogLinesChecked,
          },
          resultSha256: sha256(afterRestart),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return `cron=${cronRows.cron.execution_id}; task=${agentIdentity.execution_id}; suppression=204; restart sha256=${sha256(afterRestart)}`;
  } finally {
    await stopQaGatewayFixture(gatewayOwner).catch(() => undefined);
    await mock.stop();
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    return {
      artifacts: [{ filePath: SNAPSHOT_FILE, kind: "summary" }],
      details: await runProof(options),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Autonomous task lifecycle receipts",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/audit.md", "docs/automation/cron-jobs.md"],
      codeRefs: [
        "src/audit/execution-decision-receipts.ts",
        "src/cron/store/run-receipt-store.ts",
        "src/infra/agent-run-registry.ts",
      ],
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const evidence = await runProducer(parseOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Autonomous task lifecycle evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Autonomous task lifecycle status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
