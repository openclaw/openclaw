import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import * as transcript from "../../config/sessions/transcript.js";
import { readModelFallbackNotice } from "../../shared/model-fallback-notice.js";
import { useAccountingFixture } from "./agent-runner-accounting.test-support.js";
import { agentAccountingPersistenceDiagnostic as primary } from "./agent-runner-result-accounting.persistence.test-support.js";

const { database, createFixture } = useAccountingFixture("openclaw-restoration-");
const fallback = { provider: "fallback-fixture", model: "available" };
afterEach(() => vi.restoreAllMocks());

async function fixture(lane: "ordinary" | "followup" = "ordinary") {
  const f = await createFixture();
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
        storePath: database.storePath,
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
    const successful = structuredClone(execution);
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

    f.context.execution = successful;
    successful.result.payloads = [{ text: "recovered" }];
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
