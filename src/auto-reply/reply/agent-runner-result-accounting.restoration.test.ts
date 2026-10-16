import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import * as transcript from "../../config/sessions/transcript.js";
import { readModelFallbackNotice } from "../../shared/model-fallback-notice.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  agentAccountingPersistenceDiagnostic as primary,
  createAgentAccountingPersistenceFixture,
} from "./agent-runner-result-accounting.persistence.test-support.js";
import type { ReplyOperation } from "./reply-run-registry.js";

// Runtime outcomes are fixed fixtures; completion, source fencing and canonical transcript writes are real.
let root: string;
let storePath: string;
let sequence = 0;
const operations: ReplyOperation[] = [];
const fallback = { provider: "fallback-fixture", model: "available" };
beforeAll(() => {
  // openclaw-temp-dir: allow suite database root drains before removal
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-restoration-"));
  storePath = path.join(root, "openclaw-agent.sqlite");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  await closeOpenClawAgentDatabasesAsync(root);
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(lane: "ordinary" | "followup" = "ordinary") {
  const f = await createAgentAccountingPersistenceFixture({
    root,
    storePath,
    fixtureId: ++sequence,
    registerOperation: (operation) => operations.push(operation),
  });
  f.context.execution.resolved = fallback;
  f.context.execution.fallback.attempts = [
    { provider: primary.provider, model: primary.model, reason: "rate_limit", error: "rate limit" },
  ];
  await f.account(lane, fallback);
  const activeNotice = f.read()!.fallbackNotice!;
  expect(activeNotice).toMatchObject({
    selectedModel: `${primary.provider}/${primary.model}`,
    activeModel: "fallback-fixture/available",
  });
  f.context.execution.resolved = { provider: primary.provider, model: primary.model };
  f.context.execution.fallback.attempts = [];
  const notices = async (sessionId = f.sessionId) =>
    (
      await loadTranscriptEvents({
        agentId: "main",
        storePath,
        sessionKey: f.context.sessionKey!,
        sessionId,
      })
    )
      .map((event) => readModelFallbackNotice(asOptionalRecord(event)?.message))
      .filter(Boolean);
  return { ...f, activeNotice, notices };
}

it.each(["ordinary", "followup"] as const)(
  "records one durable primary restoration through %s completion, including replay",
  async (lane) => {
    const f = await fixture(lane);
    expect(await f.notices()).toEqual([]);
    await f.account(lane, primary);
    expect(await f.notices()).toEqual([
      {
        kind: "model-fallback",
        phase: "restored",
        runId: f.context.runId,
        fromModel: "fallback-fixture/available",
        toModel: `${primary.provider}/${primary.model}`,
      },
    ]);
    expect(f.read()?.fallbackNotice).toBeUndefined();
    // Replay after the transcript commit but before fallback bookkeeping must adopt the same event.
    await f.replace({ ...f.read()!, fallbackNotice: f.activeNotice });
    await f.account(lane, primary);
    await f.account(lane, primary);
    expect(await f.notices()).toHaveLength(1);
    expect(f.read()).toMatchObject({ modelProvider: primary.provider, model: primary.model });
  },
);

it.each(["failed", "aborted", "error", "error payload", "exhausted", "synthetic"] as const)(
  "does not announce restoration for a %s result and retains state for the next success",
  async (outcome) => {
    const f = await fixture();
    const execution = f.context.execution;
    if (outcome === "failed") {
      f.context.execution = {
        ...execution,
        status: "failed",
        terminalFailurePayload: { text: "provider failed", isError: true },
      };
    } else if (outcome === "aborted") {
      execution.result.meta.aborted = true;
    } else if (outcome === "error") {
      execution.result.meta.error = { kind: "context_overflow", message: "prompt too large" };
    } else if (outcome === "error payload") {
      execution.result.payloads = [{ text: "provider failed", isError: true }];
    } else if (outcome === "exhausted") {
      execution.fallback.exhausted = true;
    } else {
      f.context.followupRun.run.inputProvenance = {
        kind: "inter_session",
        sourceTool: "subagent_announce",
      };
    }
    await f.account("ordinary", primary);
    expect(await f.notices()).toEqual([]);
    expect(f.read()?.fallbackNotice).toEqual(f.activeNotice);

    f.context.execution = {
      ...execution,
      status: "ok",
      terminalFailurePayload: undefined,
      postCompactionModelFailure: undefined,
    };
    delete execution.result.meta.aborted;
    delete execution.result.meta.error;
    execution.result.payloads = [{ text: "recovered" }];
    execution.fallback.exhausted = false;
    delete f.context.followupRun.run.inputProvenance;
    await f.account("ordinary", primary);
    expect(await f.notices()).toHaveLength(1);
    expect(f.read()?.fallbackNotice).toBeUndefined();
  },
);

it("does not restore on user cancellation before the success owner", async () => {
  const f = await fixture("followup");
  await f.accountAborted("user");
  expect(await f.notices()).toEqual([]);
  expect(f.read()?.fallbackNotice).toEqual(f.activeNotice);
});

it("does not describe a different user-selected model as restoration of the previous primary", async () => {
  const f = await fixture();
  const selected = { provider: "new-fixture", model: "selected" };
  Object.assign(f.context.followupRun.run, selected);
  f.context.execution.resolved = selected;
  await f.replace({
    ...f.read()!,
    providerOverride: selected.provider,
    modelOverride: selected.model,
    modelOverrideSource: "user",
  });
  await f.account("ordinary", selected);
  expect(await f.notices()).toEqual([]);
  expect(f.read()?.fallbackNotice).toBeUndefined();
  expect(f.read()).toMatchObject({
    providerOverride: selected.provider,
    modelOverride: selected.model,
  });
});

it.each(["session", "lifecycle", "writer", "cancellation"] as const)(
  "rejects restoration after %s replacement at the canonical write boundary",
  async (replacement) => {
    const f = await fixture();
    const append = transcript.appendAssistantMessageToSessionTranscript;
    let replaced = false;
    vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript").mockImplementationOnce(
      async (params) => {
        replaced = true;
        if (replacement === "cancellation") {
          f.context.replyOperation.abortByUser();
        } else {
          await f.replace({
            ...f.read()!,
            ...(replacement === "session"
              ? { sessionId: "replacement-session" }
              : replacement === "lifecycle"
                ? { lifecycleRevision: "replacement-lifecycle" }
                : { activeWriterRunId: "replacement-run" }),
          });
        }
        return append(params);
      },
    );
    const accounting = f.account("ordinary", primary);
    if (replacement === "cancellation") {
      await accounting;
    } else {
      await expect(accounting).rejects.toThrow();
    }
    expect(replaced).toBe(true);
    expect(await f.notices()).toEqual([]);
    expect(await f.notices("replacement-session")).toEqual([]);
    expect(f.read()?.fallbackNotice).toEqual(f.activeNotice);
  },
);
