import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperatorInputRecoverySource,
  createRestartRecoveryOperatorSource,
} from "../agents/operator-run-recovery-source.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { loadOrCreateDeviceIdentityAsync } from "../infra/device-identity-async.js";
import {
  issueProviderReviewAcknowledgment,
  recordSessionProviderReview,
  retireProviderReviewAcknowledgment,
} from "../sessions/provider-review.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatInputRecoveryAdmission } from "./chat-input-recovery-source.js";
import { resumeChatInput } from "./chat-input-recovery.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createPendingInputRecoveryTrace } from "./pending-input-recovery-trace.js";
import { createRestartSafeChatRequest } from "./server-methods/chat-restart-recovery.js";
import {
  createChatInputRecovery,
  normalizeChatSendRequest,
} from "./server-methods/chat-send-request.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";

const dispatch = vi.hoisted(() => vi.fn());
const externalProvenance = { kind: "external_user" as const, sourceTool: "acp_bridge" };
const sourceReceipt = "[Synthetic trusted source receipt]";
vi.mock(import("./server-in-process-dispatch.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchGatewayRequestInProcess: dispatch,
}));

afterEach(() => {
  dispatch.mockReset();
  vi.restoreAllMocks();
});

async function normalize(params: Parameters<typeof normalizeChatSendRequest>[0]) {
  const result = await normalizeChatSendRequest(params);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

async function withInput(
  run: (input: Awaited<ReturnType<typeof prepareInput>>) => Promise<void>,
  approvedText = "Approved redacted input",
  withOptions = false,
  originalText = "Original private input",
) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const input = await prepareInput(stateDir, approvedText, withOptions, originalText);
    await run(input);
  });
}

async function prepareInput(
  stateDir: string,
  approvedText: string,
  withOptions: boolean,
  originalText: string,
) {
  await loadOrCreateDeviceIdentityAsync();
  const profile = ensureProfileForEmail("input-recovery@example.test");
  const fixture = await createOperatorRecoveryFixture({
    stateDir,
    context: createContext(),
    config: { agents: { ownership: "explicit", entries: { main: {}, peer: {} } } },
    sessionKey: "recovery-input",
    profileId: profile.id,
  });
  const request = await normalize({
    client: fixture.client,
    params: {
      sessionKey: fixture.target.sessionKey,
      sessionId: fixture.target.sessionId,
      idempotencyKey: fixture.target.sourceRunId,
      message: originalText,
      fastMode: true,
      timeoutMs: 42_000,
      queueMode: "followup",
      ...(withOptions
        ? {
            systemInputProvenance: externalProvenance,
            systemProvenanceReceipt: sourceReceipt,
            __controlUiReconnectResume: true,
          }
        : {}),
    },
  });
  const recovery = expectDefined(
    createChatInputRecovery({
      request,
      source: fixture.entry.restartRecoveryOperatorSource,
    }),
    "recoverable chat metadata",
  );
  const message: PersistedUserTurnMessage = {
    role: "user",
    content: approvedText,
    timestamp: Date.now(),
    idempotencyKey: `${fixture.target.sourceRunId}:user`,
    __openclaw: {
      chatInputRecovery: recovery,
      chatRequestIdentity: expectDefined(request.requestIdentity, "original request identity"),
      media: [{ url: "media://inbound/synthetic.png", contentType: "image/png" }],
    },
  };
  const receipt = expectDefined(
    await stageSessionPendingInput(fixture.target, {
      runId: fixture.target.sourceRunId,
      requestFingerprint: "original-request-fingerprint",
      message,
      assertCurrent() {},
    }),
    "accepted chat input",
  );
  receipt.finish("interrupted");
  await receipt.settled?.();
  return {
    fixture,
    profile,
    message: receipt.message,
    target: {
      ...fixture.target,
      runId: fixture.target.sourceRunId,
      message: receipt.message,
      requestHash: "request:original-request-fingerprint",
    },
    options: { signal: new AbortController().signal, assertCurrent: () => {} },
  };
}

describe("interrupted chat input recovery", () => {
  it.each([
    { body: "hello ! poll", literal: true, restartSafe: true },
    {
      body: "![diagram](https://example.com/diagram.png)",
      literal: true,
      restartSafe: true,
    },
    { body: "! poll", literal: false, restartSafe: false },
    { body: "!poll", literal: false, restartSafe: false },
    { body: "hello /status", literal: false, restartSafe: false },
  ])("preserves command interpretation and recovery for $body", ({ body, literal, restartSafe }) =>
    withInput(
      async ({ fixture, target, options }) => {
        const restartRequest = await createRestartSafeChatRequest({
          cfg: fixture.context.getRuntimeConfig(),
          eligible: true,
          message: body,
          senderIsOwner: true,
        });
        expect(Boolean(restartRequest)).toBe(restartSafe);
        dispatch.mockImplementation(async (_method, params, requestOptions) => {
          const normalized = await normalize({ params, client: requestOptions.client });
          expect(normalized).toMatchObject({
            rawMessage: body,
            suppressCommandInterpretation: literal,
          });
        });
        await resumeChatInput(fixture.context, target, options);
        expect(dispatch).toHaveBeenCalledOnce();
      },
      body,
      false,
      body,
    ),
  );
  it("leaves provider-review continuations with their process-bound acknowledgment owner", () =>
    withInput(async ({ fixture }) => {
      const reviewTarget = {
        ...fixture.target,
        lifecycleRevision: fixture.entry.lifecycleRevision,
      };
      const review = await recordSessionProviderReview({
        target: reviewTarget,
        refusal: {
          runId: "refused-run",
          provider: "openai",
          model: "gpt-5.6-sol",
          runtimeId: "codex",
          api: "openai-chatgpt-responses",
          nativeThreadId: "review-thread",
          nativeTurnId: "refused-turn",
          review: {
            explanation: "Review the proposed operation.",
            continuation: { message: "Continue the reviewed input" },
          },
        },
        assertCurrent() {},
      });
      const acknowledgment = await issueProviderReviewAcknowledgment({
        target: reviewTarget,
        reviewId: review.id,
        nextRunId: "review-continuation",
        assertCurrent() {},
      });
      try {
        const request = await normalize({
          client: fixture.client,
          params: {
            sessionKey: fixture.target.sessionKey,
            sessionId: fixture.target.sessionId,
            idempotencyKey: "review-continuation",
            message: "Continue the reviewed input",
          },
          providerReviewAcknowledgment: acknowledgment,
        });
        expect(
          createChatInputRecovery({
            request,
            source: fixture.entry.restartRecoveryOperatorSource,
          }),
        ).toBeUndefined();
      } finally {
        retireProviderReviewAcknowledgment(acknowledgment);
      }
    }));

  it("retains approved input, media, identity, provenance and chat options under the original operator", () =>
    withInput(
      async ({ fixture, target, message, options }) => {
        const now = vi.spyOn(performance, "now").mockReturnValue(0);
        const trace = createPendingInputRecoveryTrace();
        dispatch.mockImplementation(async (method, params, requestOptions) => {
          expect(method).toBe("chat.send");
          expect(
            resolveRequestedSessionAgentId(
              fixture.context.getRuntimeConfig(),
              params.sessionKey,
              params.agentId,
            ),
          ).toEqual({ ok: true, agentId: target.agentId });
          expect(params).toMatchObject({
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            idempotencyKey: target.runId,
            message: "Approved redacted input",
            fastMode: true,
            timeoutMs: 42_000,
            queueMode: "followup",
          });
          expect(JSON.stringify(params)).not.toContain("Original private input");
          expect(readChatInputRecoveryAdmission(target.runId)).toMatchObject({
            target: { message },
            requestFingerprint: "original-request-fingerprint",
          });
          expect(requestOptions.client.connect.client).toEqual(fixture.client.connect.client);
          const normalized = await normalize({
            params,
            client: requestOptions.client,
          });
          expect(normalized).toMatchObject({
            requestIdentity: message["__openclaw"]?.chatRequestIdentity,
            systemInputProvenance: externalProvenance,
            systemProvenanceReceipt: sourceReceipt,
            reconnectResumeRequested: true,
          });
          requestOptions.sessionMutationCommitGuard();
          expect(requestOptions.client.internal.operatorRunAuthority.profileId).toBe(
            fixture.client.authenticatedUserProfile?.profileId,
          );
          now.mockReturnValue(250);
        });
        await resumeChatInput(fixture.context, target, { ...options, trace });
        expect(dispatch).toHaveBeenCalledOnce();
        expect(readChatInputRecoveryAdmission(target.runId)).toBeUndefined();
        expect(trace.finish()).toEqual({
          totalMs: 250,
          sourceLoadMs: 0,
          sessionLoadMs: 0,
          authorityRestoreMs: 0,
          communicationAdmissionMs: 0,
          dispatchAckMs: 250,
          retryWaitMs: 0,
        });
      },
      "Approved redacted input",
      true,
    ));

  it.each(["archived", "replaced", "permission"] as const)(
    "does not dispatch a %s input",
    (change) =>
      withInput(async ({ fixture, target, profile, options }) => {
        if (change === "archived" || change === "replaced") {
          await replaceSessionEntry(target, {
            ...fixture.entry,
            ...(change === "archived" ? { archivedAt: Date.now() } : { sessionId: "replacement" }),
          });
        } else if (change === "permission") {
          setUserProfileRole(profile.id, "changed-role");
        }
        await expect(resumeChatInput(fixture.context, target, options)).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
      }),
  );

  it.each(["/stop", "/new"])(
    "does not interpret approved plain input transformed into %s as a command",
    (approvedText) =>
      withInput(async ({ fixture, target, options }) => {
        dispatch.mockImplementation(async (_method, params, requestOptions) => {
          expect(params.suppressCommandInterpretation).toBeUndefined();
          const normalized = await normalize({
            params,
            client: requestOptions.client,
          });
          expect(normalized).toMatchObject({
            rawMessage: approvedText,
            stopCommand: false,
            turnKind: "main",
            suppressCommandInterpretation: true,
          });
        });
        await resumeChatInput(fixture.context, target, options);
        expect(dispatch).toHaveBeenCalledOnce();
      }, approvedText),
  );

  it("rechecks live operator authority after dispatch preparation yields", () =>
    withInput(async ({ fixture, target, profile, options }) => {
      dispatch.mockImplementation(async (_method, _params, requestOptions) => {
        await Promise.resolve();
        setUserProfileRole(profile.id, "changed-role");
        requestOptions.sessionMutationCommitGuard();
      });
      await expect(resumeChatInput(fixture.context, target, options)).rejects.toThrow(/changed/);
    }));

  it("captures admitted and pending operator input authority for native child sessions", () =>
    withInput(async ({ fixture }) => {
      const captured = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: fixture.client,
          context: fixture.context,
          sourceAuthority: null,
        }),
        "current operator",
      );
      try {
        const params = {
          authority: captured.authority,
          entry: {
            ...fixture.entry,
            spawnedBy: "agent:other:group:parent",
            spawnDepth: 1,
            subagentRole: "leaf" as const,
            completionOwnerSessionKey: "agent:other:group:parent",
          },
          ...fixture.target,
          sessionKey: "agent:main:subagent:later-operator-turn",
        };
        expect(createRestartRecoveryOperatorSource(params)).toEqual(
          createOperatorInputRecoverySource(params),
        );
        expect(createOperatorInputRecoverySource(params)).toMatchObject({
          sessionId: fixture.target.sessionId,
          sourceRunId: fixture.target.sourceRunId,
        });
      } finally {
        captured.release();
      }
    }));
});
