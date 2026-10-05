import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareTranscriptMessageAppend } from "../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendAbortedSessionTranscriptPartial,
  appendSessionTranscriptReport,
  readLatestSessionTranscriptReport,
} from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { prepareCustomTranscriptReport } from "../config/sessions/session-accessor.sqlite-transcript-reports.kernel.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoTranscriptOperations } from "../config/sessions/session-incognito-transcript-contract.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { AssistantMessage } from "../llm/types.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
type IncognitoTranscriptTarget = Omit<
  IncognitoTranscriptOperations["session.report.prepare"]["input"],
  "selection"
>;
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-reports-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});

it("composes report selection and partial publication without caller-thread SQL", async () => {
  const target = await create("composition");
  const scope = {
    ...target,
    ...target.fence,
    agentId: actor.agentId,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: actor.agentId, env }),
    env,
  };
  const incognito = { actor, authority };
  const sql = observeHostDataSql();
  onTestFinished(sql.restore);
  const update = vi.fn();
  onTestFinished(onInternalSessionTranscriptUpdate(update));
  await expect(
    appendSessionTranscriptReport(
      scope,
      {
        kind: "custom",
        customTypes: ["status"],
        selectReport: () => ({ customType: "status", content: "composed report", display: true }),
      },
      { incognito },
    ),
  ).resolves.toEqual({ ok: true, value: undefined });
  expect(await readLatestSessionTranscriptReport(scope, ["status"], incognito)).toMatchObject({
    ok: true,
    value: { content: "composed report" },
  });
  expect(
    await appendAbortedSessionTranscriptPartial(
      scope,
      {
        runId: "composition-partial",
        expectedLifecycleRevision: "initial",
        message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
      },
      incognito,
    ),
  ).toMatchObject({ ok: true, value: { skipped: false, append: { appended: true } } });
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      runId: "composition-partial",
      target: expect.objectContaining({ storePath: actor.path }),
    }),
  );
  expect(sql.queries).toEqual([]);
});

it("retains the report writer assertion across actor FIFO waits", async () => {
  const target = await create("composition-revoked");
  const scope = { ...target, ...target.fence, agentId: actor.agentId, storePath: actor.path, env };
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = actor.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let allowed = true;
  const pending = withSessionTranscriptWriteAssertion(
    scope,
    () => {
      if (!allowed) {
        throw new Error("report writer revoked");
      }
    },
    () =>
      appendSessionTranscriptReport(
        scope,
        {
          kind: "custom",
          customTypes: ["status"],
          selectReport: () => ({ customType: "status", content: "refused", display: true }),
        },
        { incognito: { actor, authority } },
      ),
  );
  const refused = expect(pending).rejects.toThrow("report writer revoked");
  await Promise.resolve();
  allowed = false;
  release.resolve();
  await Promise.all([held, refused]);
  expect(await latest(target)).toEqual({ ok: true, value: undefined });
});
afterAll(async () => {
  await actor?.close();
});

async function create(name: string): Promise<IncognitoTranscriptTarget> {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: name,
      updatedAt: 10_000,
      createdAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
    },
  });
  return { sessionKey, sessionId: name, fence: { expectedLifecycleRevision: "initial" } };
}

async function prepare(target: IncognitoTranscriptTarget, content: string) {
  const result = await actor.sessions.transcript(authority, {
    type: "session.report.prepare",
    input: { ...target, selection: { kind: "custom", customTypes: ["status"] } },
  });
  assert(result.ok);
  return {
    ...target,
    prepared: result.value.prepared,
    report: prepareCustomTranscriptReport(
      { customType: "status", content, display: true },
      result.value.facts.appendParentId,
    ),
  };
}

function latest(target: IncognitoTranscriptTarget) {
  return actor.sessions.transcript(authority, {
    type: "session.report.latestCustomReport",
    input: { ...target, customTypes: ["status"] },
  });
}

it("orders competing report and message appends in the same FIFO and rejects stale selection", async () => {
  const target = await create("fifo");
  const input = await prepare(target, "first report");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = actor.run(authority, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const order: string[] = [];
  const report = actor.sessions
    .transcript(authority, { type: "session.report.append", input })
    .then((value) => {
      order.push("report");
      return value;
    });
  const message = actor.sessions
    .transcript(authority, {
      type: "session.message.append",
      input: { ...target, message: { role: "user", content: "after report", timestamp: 1 } },
    })
    .then((value) => {
      order.push("message");
      return value;
    });
  const stale = actor.sessions.transcript(authority, { type: "session.report.append", input });
  release.resolve();
  const [reported, appended, refused] = await Promise.all([report, message, stale, held]);
  expect(order).toEqual(["report", "message"]);
  expect(reported).toMatchObject({ ok: true, value: { committed: true } });
  assert(appended.ok && appended.value.append);
  expect(appended.value.append.effectiveParentId).toBe(JSON.parse(input.report.eventJson).id);
  expect(refused).toMatchObject({ ok: true, value: { committed: false } });
  expect(await latest(target)).toMatchObject({ ok: true, value: { content: "first report" } });
  const next = await prepare(target, "after message");
  expect(JSON.parse(next.report.eventJson).parentId).toBe(appended.value.append.messageId);
  expect(
    await actor.sessions.transcript(authority, { type: "session.report.append", input: next }),
  ).toMatchObject({ ok: true, value: { committed: true } });
  expect(await latest(target)).toMatchObject({ ok: true, value: { content: "after message" } });
});

it.each(["queued", "commit"] as const)(
  "refuses report authority revoked at %s without appending",
  async (stage) => {
    const target = await create(`revoked-${stage}`);
    const input = await prepare(target, "must not commit");
    let allowed = true;
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error("report authority revoked");
        }
      },
      authorize(phase) {
        expect(() => actor.sessions.readSharing(target.sessionKey)).toThrow(
          "pending or unavailable",
        );
        expect(() =>
          actor.sessions.transcript(authority, {
            type: "session.report.latestCustomReport",
            input: { ...target, customTypes: ["status"] },
          }),
        ).toThrow("authority callbacks cannot call their actor");
        if (phase === "commit" && stage === "commit") {
          allowed = false;
        }
      },
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const held = actor.run(authority, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const rejected = expect(
      actor.sessions.transcript(source, { type: "session.report.append", input }),
    ).rejects.toThrow("report authority revoked");
    if (stage === "queued") {
      allowed = false;
    }
    release.resolve();
    await Promise.all([held, rejected]);
    expect(await latest(target)).toEqual({ ok: true, value: undefined });
    expect(
      await actor.sessions.transcript(authority, { type: "session.report.append", input }),
    ).toMatchObject({ ok: true, value: { committed: true } });
  },
);

it("deduplicates assistant reports and settles aborted partials on the same actor", async () => {
  const target = await create("assistant");
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "terminal answer" }],
    api: "openai-responses",
    provider: "openai",
    model: "synthetic",
    responseId: "response",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } satisfies AssistantMessage;
  const report = { kind: "assistant" as const, message };
  const scope = { ...target, ...target.fence, agentId: actor.agentId, storePath: actor.path, env };
  await appendSessionTranscriptReport(scope, report, { incognito: { actor, authority } });
  const before = await prepare(target, "unused");
  await appendSessionTranscriptReport(scope, report, { incognito: { actor, authority } });
  const after = await prepare(target, "unused");
  expect(after.prepared.version).toEqual(before.prepared.version);
  const partial = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    __openclaw: { runId: "partial-run" },
  };
  const preparedPartial = prepareTranscriptMessageAppend({ message: partial });
  assert(preparedPartial);
  const result = await actor.sessions.transcript(authority, {
    type: "session.report.abortedPartial",
    input: {
      ...target,
      report: {
        runId: "partial-run",
        message: partial,
        expectedLifecycleRevision: "initial",
        preparedMessage: preparedPartial,
      },
    },
  });
  expect(result).toMatchObject({
    ok: true,
    value: {
      committed: true,
      sessionEntryChanged: true,
      abortedPartial: { skipped: false, append: { appended: true } },
    },
  });
  expect(actor.sessions.readSharing(target.sessionKey)?.entry?.sessionId).toBe(target.sessionId);
});
