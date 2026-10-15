import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import {
  agentAccountingPersistenceDiagnostic as diagnostic,
  createAgentAccountingPersistenceFixture,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import type { ReplyOperation } from "./reply-run-registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const operations: ReplyOperation[] = [];
let suiteRoot: string;
let storePath: string;
let fixtureSequence = 0;
beforeAll(() => {
  // openclaw-temp-dir: allow suite database root drains before removal
  suiteRoot = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-accounting-suite-"),
  );
  storePath = path.join(suiteRoot, "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  await closeOpenClawAgentDatabasesAsync(suiteRoot);
  expect(isOpenClawAgentDatabaseOpen(storePath)).toBe(false);
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});
afterEach(() => {
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
});
function createFixture() {
  return createAgentAccountingPersistenceFixture({
    storePath,
    root: tempDirs.make("openclaw-context-pressure-"),
    fixtureId: ++fixtureSequence,
    registerOperation: (operation) => {
      operations.push(operation);
    },
  });
}

it("publishes a prepared final only after its worker completion commits without host transactions", async () => {
  const fixture = await createFixture();
  const payload = { text: "durable final" };
  fixture.context.execution.result.payloads = [payload];
  const sql = observeHostDataSql();
  try {
    const result = await finalizeReplyAgentRun(fixture.context);
    expect(result).toMatchObject({ text: "durable final" });
    expect(
      sql.queries.filter((query) =>
        /\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/i.test(query),
      ),
    ).toEqual([]);
    const final = Array.isArray(result) ? result[0] : result;
    const completion = final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion;
    expect(completion).toMatchObject({
      sessionId: fixture.sessionId,
      sessionKey: fixture.context.sessionKey,
      storePath,
    });
    expect(fixture.read()?.pendingFinalDelivery).toMatchObject({
      intentId: completion?.intentId,
      deliveries: [{ id: completion?.deliveryId, state: "prepared" }],
      text: "durable final",
    });
  } finally {
    sql.restore();
  }
});

it("keeps a committed local answer in history without a second final delivery intent", async () => {
  const fixture = await createFixture();
  const scope = await fixture.persistLocalReply("Committed local answer.");
  const { context } = fixture;
  const settledAt = 1_000;
  const settled = {
    ...fixture.read()!,
    status: "done" as const,
    endedAt: settledAt,
    updatedAt: settledAt,
    lastRunId: context.runId,
  };
  await fixture.replace(settled);
  context.activeSessionEntry = settled;
  context.activeSessionStore![scope.sessionKey] = settled;
  context.execution.result.meta.agentMeta = {
    sessionId: fixture.sessionId,
    provider: diagnostic.provider,
    model: diagnostic.model,
    usage: { input: 120, output: 8 },
  };

  const result = await finalizeReplyAgentRun(context);

  expect(result).toMatchObject({ text: "Committed local answer." });
  const final = Array.isArray(result) ? result[0] : result;
  expect(final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion).toBeUndefined();
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  expect(fixture.read()).toMatchObject({
    status: "done",
    endedAt: settledAt,
    updatedAt: settledAt,
    inputTokens: 120,
    outputTokens: 8,
  });
  expect(fixture.read()?.pendingFinalDelivery).toBeUndefined();
  expect(await sessionAccessor.loadTranscriptEvents(scope)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.objectContaining({ role: "assistant", content: "Committed local answer." }),
      }),
    ]),
  );
});

it.each([
  "external route",
  "explicit delivery route",
  "unconfirmed transcript",
  "message-tool delivery",
  "media",
  "generated text",
  "usage footer",
  "reminder note",
] as const)("retains final custody for %s", async (reason) => {
  const fixture = await createFixture();
  const { context } = fixture;
  context.sessionCtx = { Provider: "webchat", Surface: "webchat" };
  context.opts = { resolveReplyDelivery: async () => "delivered" };
  context.execution.result.sourceReplyDeliveryState = "missing";
  const payload = setReplyPayloadMetadata(
    {
      text:
        reason === "reminder note" ? "Final answer. I'll remind you tomorrow." : "Final answer.",
      ...(reason === "media" ? { mediaUrl: "https://example.invalid/final.png" } : {}),
    },
    reason === "generated text" ? {} : { assistantMessageIndex: 0, assistantTranscriptOwned: true },
  );
  context.execution.result.payloads = [payload];
  if (reason === "external route") {
    context.sessionCtx = {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:synthetic",
    };
  } else if (reason === "explicit delivery route") {
    context.sessionCtx.ExplicitDeliverRoute = true;
  } else if (reason === "unconfirmed transcript") {
    context.opts.resolveReplyDelivery = async () => "missing";
  } else if (reason === "message-tool delivery") {
    context.execution.result.sourceReplyDeliveryState = "delivered";
  } else if (reason === "usage footer") {
    context.cfg.messages = { responseUsage: "tokens" };
    context.execution.result.meta.agentMeta = {
      sessionId: fixture.sessionId,
      provider: diagnostic.provider,
      model: diagnostic.model,
      usage: { input: 120, output: 8 },
    };
  }

  const result = await finalizeReplyAgentRun(context);

  const final = Array.isArray(result) ? result[0] : result;
  expect(final?.text).toContain("Final answer.");
  expect(final && getReplyPayloadMetadata(final)?.pendingFinalDeliveryCompletion).toBeDefined();
  expect(fixture.read()?.pendingFinalDelivery).toMatchObject({
    deliveries: [{ state: "prepared" }],
  });
});
