import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  streamMocks,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "../../agents/sessions/agent-session-types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  listSessionPendingInputs,
  loadExactSessionEntryReadOnly,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { handleGatewayRequest } from "../server-methods.js";
import { dispatchInboundMessageMock } from "../test-helpers.js";
import { bindSteeringTools } from "./chat-send-authority.test-support.js";
import {
  setClientProfile,
  setNativeIosClient,
  type useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

async function collectFailure(failures: Set<unknown>, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    failures.add(error);
  }
}

export function registerChatSteeringCommitCases(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  it.each([
    "internal fresh",
    "native custody",
    "native committed",
    "browser custody",
    "browser custody workspace",
    "browser custody session ACL",
    "browser custody lifecycle",
  ] as const)(
    "owns the real backing-run outcome when authority changes at steering commit (%s)",
    async (inputState) => {
      const sharedProfileCustody =
        inputState === "browser custody" ||
        inputState === "browser custody workspace" ||
        inputState === "browser custody session ACL";
      const creator = sharedProfileCustody
        ? ensureProfileForEmail("steering-session-creator@example.test")
        : undefined;
      const fixture = await createBrowserFollowupFixture({
        preserveContent: true,
        ...(creator
          ? { createdActor: { type: "human", source: "profile", id: creator.id } as const }
          : {}),
      });
      const { scope, params, context, client, beforeApprove } = fixture;
      const runId = params.idempotencyKey;
      const failures = new Set<unknown>();
      let releaseProviders = () => {};
      let backingRun: Promise<void> | undefined;
      try {
        if (inputState === "browser custody workspace") {
          await patchSessionEntryCore(scope, () => ({
            pendingProjectGitUrl: "file:///synthetic/missing-project.git",
          }));
        }
        const browserCustody = sharedProfileCustody || inputState === "browser custody lifecycle";
        params.queueMode = "steer";
        const operation = expectDefined(fixture.activeRun, "captured backing run");
        const email = "steering-commit@example.test";
        const profile = ensureProfileForEmail(email);
        const target = ensureProfileForEmail("steering-commit-target@example.test");
        if (creator) {
          expect(profile.id).not.toBe(creator.id);
          expect(target.id).not.toBe(creator.id);
          client.connect.scopes = ["operator.read", "operator.write"];
          await patchSessionEntryCore(scope, () => ({ visibility: "shared" }));
          expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: creator.id },
          });
        }
        if (!browserCustody) {
          setNativeIosClient(client);
        }
        if (inputState === "internal fresh") {
          params.systemInputProvenance = {
            kind: "internal_system",
            sourceTool: "internal-steering-fixture",
          };
        }
        setClientProfile(client, profile);
        const sessionManager = SessionManager.open(scope, path.dirname(scope.storePath));
        const inputKey = `${runId}:user`;
        let recorder: UserTurnTranscriptRecorder | undefined;
        let initialRuntimeReceipt: ReturnType<UserTurnTranscriptRecorder["getAdmissionReceipt"]>;
        guardSessionManager(sessionManager, {
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          runId: "native-backing-run",
          onUserMessagePersisted: (message) => {
            if ("idempotencyKey" in message && message.idempotencyKey === inputKey) {
              initialRuntimeReceipt = structuredClone(recorder?.getAdmissionReceipt());
            }
          },
        });
        const { session } = await createTestSession({ sessionManager });
        const terminals: AgentSessionEvent[] = [];
        session.subscribe((event) => {
          if (event.type === "agent_end" || event.type === "agent_settled") {
            terminals.push(event);
          }
        });
        const backingProvider = holdAssistantResponse("backing answer");
        const steeringProvider = holdAssistantResponse("accepted steering completed");
        streamMocks.streamSimple
          .mockImplementationOnce(() => backingProvider.response)
          .mockImplementation((model) =>
            inputState === "native committed"
              ? steeringProvider.response
              : createAssistantResultStream(
                  createAssistant(model, [{ type: "text", text: "accepted steering completed" }]),
                ),
          );
        releaseProviders = () => {
          backingProvider.release();
          steeringProvider.release();
        };
        backingRun = session.prompt("Continue the original backing work.");
        const cancel = vi.fn();
        const fingerprint = "steering-commit-tools";
        bindSteeringTools(operation, fingerprint);
        operation.setPhase("running");
        operation.attachBackend({
          kind: "embedded",
          runId: "native-backing-run",
          toolAuthorityFingerprint: fingerprint,
          cancel,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async (text, options, assertCurrent) => {
              recorder = options?.userTurnTranscriptRecorder;
              return await steerActiveSessionWithOptionalDeliveryWait(
                session,
                text,
                options,
                scope.sessionKey,
                () => {
                  assertCurrent();
                  return true;
                },
              );
            },
          },
        });
        await vi.waitFor(() => expect(streamMocks.streamSimple).toHaveBeenCalledOnce());
        const ack = await fixture.send(undefined, { expectedProfileId: profile.id });
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        expect(ack).toHaveBeenCalledOnce();
        const originalAck = structuredClone(ack.mock.calls);
        recorder = expectDefined(recorder, "backing runtime input recorder");
        if (inputState === "internal fresh") {
          expect((await recorder.resolveMessage())?.["__openclaw"]?.transport).toBeUndefined();
        }
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
        const persistFallback = vi.spyOn(recorder, "persistFallback");
        const pending = await listSessionPendingInputs(scope);
        expect(pending.total).toBe(inputState === "internal fresh" ? 0 : 1);
        expect(
          beforeApprove.mock.calls.filter(
            ([message]) => "idempotencyKey" in message && message.idempotencyKey === inputKey,
          ),
        ).toHaveLength(inputState === "internal fresh" ? 0 : 1);
        beforeApprove.mockClear();
        if (
          sharedProfileCustody ||
          inputState === "native custody" ||
          inputState === "browser custody lifecycle"
        ) {
          expect(session.getSteeringMessages()).toEqual([params.message]);
          expect(session.isStreaming).toBe(true);
          expect(backingProvider.isReleased()).toBe(false);
          expect(pending.items[0]).toMatchObject({
            runId,
            state: "queued",
            message: { idempotencyKey: inputKey, content: params.message },
          });
        }
        if (sharedProfileCustody || inputState === "native custody") {
          linkEmail(email, target.id);
          if (inputState === "browser custody session ACL") {
            await initializeSessionReadContext(context);
            const visibility = {
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              visibility: "draft",
            };
            const respond = vi.fn<RespondFn>();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: "revoke-steering-session-access",
                method: "session.visibility.set",
                params: visibility,
              },
              client: identifiedClient(creator!.id),
              context,
              isWebchatConnect: () => true,
              respond,
            });
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              { ok: true, sessionKey: scope.sessionKey, visibility: "draft" },
              undefined,
            );
            expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: creator!.id },
            });
            expect(operation.result).toBeNull();
            expect(backingProvider.isReleased()).toBe(false);
          }
        } else if (inputState === "browser custody lifecycle") {
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          rotateAgentEventLifecycleGeneration();
          expect(cancel).toHaveBeenCalledExactlyOnceWith("restart");
          expect(operation.result).toMatchObject({
            kind: "aborted",
            code: "aborted_for_restart",
          });
        } else if (inputState === "internal fresh") {
          beforeApprove.mockImplementation(() => linkEmail(email, target.id));
        }
        backingProvider.release();
        if (inputState === "native committed") {
          await vi.waitFor(() => expect(initialRuntimeReceipt).toBeDefined());
          // Source finalization confirms steering metadata after the runtime commit.
          // Keep the backing provider held until that final receipt is observable.
          await vi.waitFor(() =>
            expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
              ok: true,
              payload: { runId, status: "ok" },
            }),
          );
          const finalReceipt = structuredClone(recorder.getAdmissionReceipt());
          const committedTranscript = loadTranscriptEventsSync(scope);
          expect(finalReceipt).toBeDefined();
          expect(operation.result).toBeNull();
          expect(session.isStreaming).toBe(true);
          expect(beforeApprove).not.toHaveBeenCalled();
          linkEmail(email, target.id);
          expect(await recorder.persistApproved()).toBeUndefined();
          expect(recorder.getAdmissionReceipt()).toEqual(finalReceipt);
          expect(loadTranscriptEventsSync(scope)).toEqual(committedTranscript);
          expect(beforeApprove).not.toHaveBeenCalled();
          steeringProvider.release();
        }
        await backingRun;
        await fixture.finishDispatch();
        const revoked =
          inputState === "browser custody lifecycle" ||
          inputState === "browser custody session ACL";
        const refused = inputState === "internal fresh";
        const failed = revoked || refused;
        const sessionRevoked = inputState === "browser custody session ACL";
        const sourceError = expect.stringContaining(
          sessionRevoked ? "session is draft for this connection" : "Pending input ownership ended",
        );
        expect(session.messages.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: failed ? "error" : "stop",
          ...(failed
            ? {
                errorMessage: sessionRevoked
                  ? expect.stringContaining("Message injection authority is no longer current")
                  : revoked
                    ? sourceError
                    : expect.any(String),
              }
            : {}),
        });
        const transcript = loadTranscriptEventsSync(scope);
        const originalInputs = transcript.filter(
          (entry) =>
            isRecord(entry) &&
            entry.type === "message" &&
            isRecord(entry.message) &&
            entry.message.idempotencyKey === inputKey,
        );
        const cached = structuredClone(context.dedupe.get(`chat:${runId}`));
        expect(ack.mock.calls).toEqual(originalAck);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(cancel.mock.calls).toEqual(
          inputState === "browser custody lifecycle" ? [["restart"]] : [],
        );
        expect(session.isStreaming).toBe(false);
        expect(session.getSteeringMessages()).toEqual([]);
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(failed ? 1 : 2);
        expect(
          beforeApprove.mock.calls.map(([message]) =>
            "idempotencyKey" in message ? message.idempotencyKey : undefined,
          ),
        ).toEqual(refused ? [inputKey, inputKey] : []);
        expect(originalInputs).toHaveLength(failed ? 0 : 1);
        expect(cached).toMatchObject({
          ok: !failed,
          payload: { runId, status: failed ? "error" : "ok" },
        });
        expect(rpcSourceTesting.size).toBe(0);
        if (failed) {
          expect(recorder.getAdmissionReceipt()).toBeUndefined();
          expect(transcript).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "assistant",
                stopReason: "error",
                __openclaw: expect.objectContaining({ runId: "native-backing-run" }),
              }),
            }),
          );
        }
        if (revoked) {
          expect(terminals.map((event) => event.type)).toEqual(["agent_end", "agent_settled"]);
          expect(cached).toMatchObject({ error: { message: sourceError } });
          expect(
            vi
              .mocked(context.broadcast)
              .mock.calls.filter(
                ([event, payload]) =>
                  event === "chat" &&
                  isRecord(payload) &&
                  payload.runId === runId &&
                  payload.state === "error",
              )
              .map(([, payload]) => payload),
          ).toMatchObject([{ runId, state: "error", errorMessage: sourceError }]);
          expect(await listSessionPendingInputs(scope)).toMatchObject({
            total: 1,
            items: [{ ...pending.items[0], state: "interrupted" }],
          });
        } else {
          expect(terminals.filter((event) => event.type === "agent_end")).toHaveLength(1);
          expect(terminals.filter((event) => event.type === "agent_settled")).toHaveLength(1);
          if (refused) {
            expect(persistFallback).toHaveBeenCalledOnce();
            // Memory consumption precedes persistence; refusal terminates the backing run.
            expect(session.messages).toContainEqual(
              expect.objectContaining({
                role: "user",
                content: expect.arrayContaining([
                  expect.objectContaining({ type: "text", text: params.message }),
                ]),
              }),
            );
            expect(context.broadcast).toHaveBeenCalledWith(
              "chat",
              expect.objectContaining({
                runId,
                state: "error",
                errorMessage: expect.stringContaining("Selected account changed"),
              }),
              expect.anything(),
            );
          } else {
            expect(recorder.getAdmissionReceipt()).toBeDefined();
          }
          if (inputState === "browser custody workspace") {
            expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
              pendingProjectGitUrl: "file:///synthetic/missing-project.git",
            });
          }
          const staleRetry = await fixture.send(undefined, { expectedProfileId: profile.id });
          expect(staleRetry).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
            }),
          );
          expect(context.dedupe.get(`chat:${runId}`)).toEqual(cached);
          expect(loadTranscriptEventsSync(scope)).toEqual(transcript);
          expect(rpcSourceTesting.size).toBe(0);
          expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
        }
      } catch (error) {
        failures.add(error);
      } finally {
        releaseProviders();
        await collectFailure(failures, async () => backingRun);
        await collectFailure(failures, () => fixture.cleanup());
      }
      if (failures.size === 1) {
        throw failures.values().next().value;
      }
      if (failures.size > 1) {
        throw new AggregateError(failures, "Backing-run fixture and cleanup failed", {
          cause: failures.values().next().value,
        });
      }
    },
  );
}
