import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapRunWithTestPreparedAdmission } from "../agents/admitted-run-context.test-support.js";
import { OAuthRefreshFailureError } from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { runCliAgent } from "../agents/cli-runner.js";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import { FailoverError, isFailoverError } from "../agents/failover-error.js";
import {
  appendFailedCandidateAttempt,
  throwFallbackFailureSummary,
} from "../agents/model-fallback-attempt.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import { createAgentLifecycleTerminalBackstop } from "../auto-reply/reply/agent-lifecycle-terminal.js";
import { resolveReplyFailureSummary } from "../auto-reply/reply/agent-runner-failure-reply.js";
import { buildReplyPayloads } from "../auto-reply/reply/agent-runner-payloads.js";
import { normalizeReplyPayloadOutcome } from "../auto-reply/reply/normalize-reply.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import type { RespondFn } from "./server-methods/types.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

const target = {
  agentId: "main",
  sessionId: "billing-failure-session",
  sessionKey: "agent:main:billing-failure",
};
const runId = "billing-failure-run";
const provider = "billing-fixture-cli";
const model = "billing-fixture-model";
type AuthMode = AuthProfileCredential["type"] | "cli";
type Producer = "chat" | "command";

type BillingFixture = {
  state: OpenClawTestState;
  session: Awaited<ReturnType<typeof seedSession>>;
};
let fixture: BillingFixture;
let caseWork: Promise<void> | undefined;

function notePhase(phase: string) {
  if (process.env.OPENCLAW_TEST_BILLING_PHASES === "1") {
    console.info(`[billing recovery] ${new Date().toISOString()} ${phase}`);
  }
}

beforeEach(async ({ signal, onTestFinished }) => {
  caseWork = undefined;
  const acquisition = (async () => {
    notePhase("fixture acquisition started");
    const state = await createOpenClawTestState({ scenario: "minimal" });
    try {
      signal.throwIfAborted();
      const session = await seedSession(state);
      signal.throwIfAborted();
      notePhase("fixture acquisition completed");
      return { state, session };
    } catch (error) {
      await state.cleanup();
      throw error;
    }
  })();
  // A test deadline must join its cancelled CLI/read work before removing state
  // or allowing the next case to replace the process-wide fixture environment.
  onTestFinished(async () => {
    try {
      await caseWork?.catch(() => undefined);
      const acquired = await acquisition.catch(() => undefined);
      if (acquired) {
        notePhase("fixture cleanup started");
        await acquired.state.cleanup();
        notePhase("fixture cleanup completed");
      }
    } finally {
      cliBackendsTesting.resetDepsForTest();
    }
  });
  fixture = await acquisition;
});

function withBillingFixture(run: (ready: BillingFixture) => Promise<void>): Promise<void> {
  caseWork = run(fixture);
  return caseWork;
}

async function seedSession(state: OpenClawTestState) {
  const sessionFile = path.join(state.sessionsDir(), `${target.sessionId}.jsonl`);
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    sessionFile,
    updatedAt: 1_000,
    startedAt: 1_000,
    status: "running",
    lifecycleRunId: runId,
    activeWriterRunId: runId,
  });
  await replaceTranscriptEvents(target, [
    { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
    {
      type: "message",
      id: "billing-user-turn",
      parentId: null,
      message: { role: "user", content: "Please reply." },
    },
  ]);
  return { sessionFile, sessionTarget: await resolveSessionTranscriptRuntimeTarget(target) };
}

async function failCliRun(
  state: OpenClawTestState,
  session: Awaited<ReturnType<typeof seedSession>>,
  authMode: AuthMode,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const scriptPath = await state.writeText(
    "billing-cli.mjs",
    'process.stderr.write("Credit balance is too low"); process.exitCode = 1;\n',
  );
  const authProfileId = authMode === "cli" ? undefined : `${provider}:${authMode}`;
  if (authProfileId) {
    const credential: AuthProfileCredential =
      authMode === "oauth"
        ? {
            type: "oauth",
            provider,
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 3_600_000,
          }
        : authMode === "token"
          ? { type: "token", provider, token: "synthetic-token" }
          : { type: "api_key", provider, key: "synthetic-key" };
    await state.writeAuthProfiles({ version: 1, profiles: { [authProfileId]: credential } });
  }
  // Only backend discovery and the external executable are fixtures. Preparation,
  // credential selection, process execution, and error settlement remain real.
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: provider,
        pluginId: "billing-fixture",
        autoSelectAuthProfile: false,
        config: {
          command: process.execPath,
          args: [scriptPath],
          output: "text",
          input: "arg",
          sessionMode: "none",
          systemPromptWhen: "never",
        },
      },
    ],
  });
  notePhase(`CLI ${authMode} started`);
  const error: unknown = await wrapRunWithTestPreparedAdmission(runCliAgent)({
    ...target,
    ...session,
    workspaceDir: state.workspaceDir,
    agentDir: state.agentDir(),
    authProfileId,
    prompt: "Please reply.",
    provider,
    model,
    timeoutMs: 5_000,
    abortSignal: signal,
    runId,
    config: { agents: { defaults: { workspace: state.workspaceDir } } },
  }).catch((caught: unknown) => caught);
  signal.throwIfAborted();
  notePhase(`CLI ${authMode} completed`);
  expect(isFailoverError(error)).toBe(true);
  expect(error).toMatchObject({ reason: "billing", authMode });
  return error;
}

function emitTerminalFailure(error: unknown, producer: Producer): AgentEventPayload {
  const events: AgentEventPayload[] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "lifecycle" && event.data.phase === "error") {
      events.push(event);
    }
  });
  try {
    if (producer === "chat") {
      createAgentLifecycleTerminalBackstop({
        runId,
        sessionKey: target.sessionKey,
        startedAt: 1_000,
        getLifecycleGeneration: getAgentEventLifecycleGeneration,
        resolveTerminationFields: () => ({}),
      }).emit("error", error);
    } else {
      createAgentCommandLifecycle({
        runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration,
        startedAt: 1_000,
        state: {
          currentTurnUserMessagePersisted: true,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
      }).emitBasicError(error);
    }
  } finally {
    unsubscribe();
  }
  expect(events).toHaveLength(1);
  return expectDefined(events[0], "terminal lifecycle event");
}

async function persistAndReadHistory(event: AgentEventPayload) {
  notePhase("terminal persistence started");
  await persistGatewaySessionLifecycleEvent({ ...target, event });
  await persistGatewaySessionLifecycleEvent({ ...target, event });
  const reports = (await loadTranscriptEvents(target)).filter(
    (entry) => isRecord(entry) && entry.customType === "run-failed-before-reply",
  );
  expect(reports).toHaveLength(1);
  notePhase("terminal persistence completed; chat.history started");
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    chatHistoryHandlers["chat.history"],
    "history handler",
  )({
    params: { sessionKey: target.sessionKey },
    respond,
    req: { type: "req", id: "billing-history", method: "chat.history" },
    client: null,
    isWebchatConnect: () => false,
    context: await createHistoryReadContext(),
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, payload] = expectDefined(respond.mock.calls[0], "history response");
  expect(ok).toBe(true);
  expect(isRecord(payload) && Array.isArray(payload.messages)).toBe(true);
  const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  const notices = messages.filter(
    (message) => isRecord(message) && message.customType === "run-failed-before-reply",
  );
  expect(notices).toHaveLength(1);
  notePhase("chat.history completed");
  return { report: reports[0], notice: notices[0] };
}

async function normalizeChannelFailure(error: unknown) {
  assert(isFailoverError(error));
  const summary = expectDefined(
    resolveReplyFailureSummary({
      error,
      message: error.message,
      reason: error.reason,
      attempts: error.attempts,
    }),
    "billing failure summary",
  );
  const { replyPayloads } = await buildReplyPayloads({
    payloads: [{ text: summary.text, isError: true }],
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
  });
  expect(replyPayloads).toHaveLength(1);
  const payload = expectDefined(replyPayloads[0], "channel failure payload");
  expect(payload.text).toBe(summary.text);
  const outcome = normalizeReplyPayloadOutcome(payload);
  expect(outcome).toMatchObject({ payload: { text: summary.text, isError: true } });
  return summary.text;
}

function expectRecoveryCopy(text: string, authMode: AuthMode) {
  expect(text).not.toContain("API key");
  expect(text).not.toContain("Credit balance is too low");
  if (authMode === "cli") {
    expect(text).toContain("account used by this CLI");
    expect(text).not.toContain("subscription");
  } else if (authMode === "oauth" || authMode === "token") {
    expect(text).toContain("subscription or usage limits");
    expect(text).not.toContain("account used by this CLI");
  } else {
    expect(text).toContain("credit balance and usage limits");
    expect(text).not.toContain("subscription");
    expect(text).not.toContain("account used by this CLI");
  }
}

function aggregateFailures(attempts: FallbackAttempt[], lastError: unknown): unknown {
  try {
    return throwFallbackFailureSummary({
      attempts,
      candidates: attempts,
      lastError,
      label: "models",
      formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
    });
  } catch (caught) {
    return caught;
  }
}

describe("prepared CLI billing recovery through Gateway failure history", () => {
  it.for(
    (["chat", "command"] as const).flatMap((producer) =>
      (["cli", "oauth", "token", "api_key"] as const).map((authMode) => ({
        producer,
        authMode,
      })),
    ),
  )(
    "keeps $authMode recovery through the $producer terminal producer",
    async ({ producer, authMode }, { signal }) => {
      await withBillingFixture(async ({ state, session }) => {
        const error = await failCliRun(state, session, authMode, signal);
        const event = emitTerminalFailure(error, producer);
        const { report, notice } = await persistAndReadHistory(event);
        const deliveredText = await normalizeChannelFailure(error);
        expectRecoveryCopy(String(event.data.error), authMode);
        expectRecoveryCopy(JSON.stringify(report), authMode);
        expectRecoveryCopy(JSON.stringify(notice), authMode);
        expectRecoveryCopy(deliveredText, authMode);
      });
    },
  );

  it.for(["cli", "oauth"] as const)(
    "keeps an earlier %s billing failure after an API-key fallback also fails",
    async (authMode, { signal }) => {
      await withBillingFixture(async ({ state, session }) => {
        const attempts: FallbackAttempt[] = [];
        let lastError: unknown;
        for (const mode of [authMode, "api_key"] as const) {
          lastError = await failCliRun(state, session, mode, signal);
          appendFailedCandidateAttempt({
            attempts,
            candidate: { provider, model },
            error: lastError,
          });
        }
        const error = aggregateFailures(attempts, lastError);
        expect(error).toMatchObject({
          authMode: "api_key",
          attempts: [{ authMode }, { authMode: "api_key" }],
        });
        const event = emitTerminalFailure(error, "chat");
        const { report, notice } = await persistAndReadHistory(event);
        const deliveredText = await normalizeChannelFailure(error);
        expectRecoveryCopy(String(event.data.error), authMode);
        expectRecoveryCopy(JSON.stringify(report), authMode);
        expectRecoveryCopy(JSON.stringify(notice), authMode);
        expectRecoveryCopy(deliveredText, authMode);
      });
    },
  );

  it.for(
    (["chat", "command"] as const).flatMap((producer) =>
      (["missing-profile", "oauth-refresh"] as const).map((finalFailure) => ({
        producer,
        finalFailure,
      })),
    ),
  )(
    "keeps earlier CLI billing ahead of $finalFailure through the $producer producer",
    async ({ producer, finalFailure }, { signal }) => {
      await withBillingFixture(async ({ state, session }) => {
        const billingError = await failCliRun(state, session, "cli", signal);
        const finalError =
          finalFailure === "missing-profile"
            ? new FailoverError("Selected saved profile was not found", {
                reason: "auth",
                provider: "fallback-provider",
                model: "fallback-model",
                code: "selected_auth_profile_unavailable",
              })
            : new OAuthRefreshFailureError({
                provider: "fallback-provider",
                message: "OAuth token refresh failed: invalid_grant",
                reason: "refresh_token_reused",
                errorType: "invalid_request_error",
                status: 401,
                summary: "Your refresh token has already been used. Please sign in again.",
              });
        const attempts: FallbackAttempt[] = [];
        appendFailedCandidateAttempt({
          attempts,
          candidate: { provider, model },
          error: billingError,
        });
        appendFailedCandidateAttempt({
          attempts,
          candidate: { provider: "fallback-provider", model: "fallback-model" },
          error: finalError,
        });
        const error = aggregateFailures(attempts, finalError);
        const event = emitTerminalFailure(error, producer);
        const { report, notice } = await persistAndReadHistory(event);
        const deliveredText = await normalizeChannelFailure(error);
        expect(event.data.error).toBe(deliveredText);
        for (const text of [deliveredText, JSON.stringify(report), JSON.stringify(notice)]) {
          expectRecoveryCopy(text, "cli");
          expect(text).not.toContain("refresh token");
          expect(text).not.toContain("saved login isn't available");
        }
      });
    },
  );
});
