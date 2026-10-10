import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCloseParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
  validateTalkClientTranscriptParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
} from "../../../config/sessions/session-source-authority.js";
import { createPluginRuntime } from "../../../plugins/runtime/index.js";
import { readOpenClawAgentDatabaseIdentity } from "../../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseRuntime } from "../../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../../talk/agent-consult-tool.js";
import { controlRealtimeVoiceAgentRun } from "../../../talk/agent-run-control.js";
import {
  assertClientVoiceSessionOpen,
  resolveOpenClientVoiceSessionId,
} from "../../../talk/client-voice-session-read.js";
import {
  captureClientVoiceSessionSourceOptions,
  createClientVoiceSessionSource,
} from "../../../talk/client-voice-session-source.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session-write.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../../talk/client-voice-session.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import { resolveSandboxedSessionCreation } from "../../operator-session-run.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { formatForLog } from "../../ws-log.js";
import { startTalkRealtimeAgentConsult } from "../agent-consult.js";
import { prepareTalkClientControlAuthority } from "../client-agent-consult.js";
import {
  closeTalkClientGatewayControlSession,
  resolveTalkAgentConsultAuthority,
} from "../client-gateway-control.js";
import {
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
} from "../relay/operations.js";
import { talkRequestError } from "../request-error.js";
import { resolveOwnedActiveTalkRunTarget } from "../run-ownership.js";
import { prepareTalkSessionTarget, requirePreparedTalkSessionTarget } from "../session-target.js";
import { unregisterTalkVoiceSession } from "../voice-selection.js";
import { createTalkClient } from "./client-create.js";
import {
  forgetLegacyVoiceBinding,
  readLegacyVoiceBinding,
  rememberLegacyVoiceBinding,
} from "./client-legacy-voice-bindings.js";

export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": createTalkClient,
  "talk.client.toolCall": defineValidatedGatewayHandler(
    "talk.client.toolCall",
    validateTalkClientToolCallParams,
    async (request) => {
      const { params, respond } = request;
      if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
        );
        return;
      }

      const config = request.context.getRuntimeConfig();
      const target = requirePreparedTalkSessionTarget(
        request.sessionMutationAuthorization?.talkSessionTarget,
      );
      const { agentId } = target;
      request.sessionMutationAuthorization?.assertCurrent();
      const relaySessionId = normalizeOptionalString(params.relaySessionId);
      const connId = normalizeOptionalString(request.client?.connId);
      const explicitVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
      if (relaySessionId && explicitVoiceSessionId && explicitVoiceSessionId !== relaySessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "relaySessionId and voiceSessionId must match"),
        );
        return;
      }
      const voiceOptions = captureClientVoiceSessionSourceOptions(agentId);
      const prepareVoiceSession = async (assertStoreCurrent?: () => void) => {
        const requester = readGatewayRequestMutationAuthority(request);
        const preparedRequester = await prepareSessionSourceAuthority(requester.assertCurrent);
        const borrowedRequester = Object.assign(() => requester.assertCurrent(), {
          prepareSessionSource: async () => ({ ...preparedRequester, release: undefined }),
        });
        const errors: unknown[] = [];
        try {
          const assertPreparationCurrent = () => {
            assertStoreCurrent?.();
            requester.assertPreparationCurrent();
            if (preparedRequester.assertPreparedCurrent) {
              preparedRequester.assertPreparedCurrent();
            } else if (!preparedRequester.nativeSource) {
              preparedRequester.assertCurrent();
            }
          };
          // SDK callbacks may read SQLite; keep them outside the worker admission grants.
          if (preparedRequester.opaqueCommitGuard) {
            requester.assertCurrent();
          }
          const physicalSource = await withOpenClawAgentDatabaseRuntime(
            voiceOptions,
            (database) => {
              const identity = readOpenClawAgentDatabaseIdentity(database);
              if (typeof identity.identity !== "string") {
                throw new Error("Voice metadata requires its admitted persistent database");
              }
              return createClientVoiceSessionSource(voiceOptions, {
                key: `file:${identity.identity}`,
                canonicalPath: identity.canonicalPath,
                birthtime: identity.birthtime,
              });
            },
            assertPreparationCurrent,
            request.signal,
          );
          if (preparedRequester.opaqueCommitGuard) {
            requester.assertCurrent();
          }
          physicalSource.assertCurrent();
          assertStoreCurrent?.();
          request.sessionMutationAuthorization?.assertCurrent();
          // Shipped clients may consult without ever creating a voice session (old app,
          // restarted gateway, ambiguous open records). Implicitly create one instead of
          // erroring so voice identity and mutation evidence stay always-on.
          let selectedVoiceSessionId =
            explicitVoiceSessionId ??
            relaySessionId ??
            (connId ? readLegacyVoiceBinding(connId, params.sessionKey) : undefined);
          if (selectedVoiceSessionId === undefined) {
            const inferred = await resolveOpenClientVoiceSessionId(
              { agentId, sessionKey: params.sessionKey },
              physicalSource.options,
            );
            physicalSource.assertCurrent();
            // Another consult may have created and bound this connection during the read.
            selectedVoiceSessionId =
              (connId ? readLegacyVoiceBinding(connId, params.sessionKey) : undefined) ?? inferred;
          }
          if (!relaySessionId) {
            assertStoreCurrent?.();
            request.sessionMutationAuthorization?.assertCurrent();
          }
          const voiceSessionId =
            selectedVoiceSessionId ??
            (await createOrResumeClientVoiceSession({
              agentId,
              sessionKey: params.sessionKey,
              origin: "client",
              physicalSource,
              requester: borrowedRequester,
              source: {
                storePath: target.storePath,
                assertCurrent: request.sessionMutationAuthorization?.assertCurrent ?? (() => {}),
              },
              assertCurrent: () => {
                assertStoreCurrent?.();
                readGatewayRequestMutationAuthority(request).assertPreparationCurrent();
              },
            }));
          if (relaySessionId && connId) {
            await ensureClientVoiceAgentSessionEntry({
              agentId,
              sessionKey: target.canonicalKey,
              storePath: target.storePath,
              creation: resolveSandboxedSessionCreation(request.client, config),
              requester: borrowedRequester,
              source: request.sessionMutationAuthorization?.assertCurrent,
              prepareWorkerGrant: request.sessionMutationAuthorization?.prepareWorkerGrant,
              assertCurrent: () => {
                assertStoreCurrent?.();
                readGatewayRequestMutationAuthority(request).assertPreparationCurrent();
              },
              onCommittedSource: (readSource, entry) =>
                request.sessionMutationAuthorization?.recordCreatedSession?.({
                  agentId,
                  sessionKey: target.canonicalKey,
                  storePath: target.storePath,
                  sessionId: entry.sessionId,
                  lifecycleRevision: entry.lifecycleRevision,
                  readSource,
                }),
            });
            assertStoreCurrent?.();
            request.sessionMutationAuthorization?.assertCurrent();
            await ensureTalkRealtimeRelayVoiceSession({
              relaySessionId,
              connId,
              sessionKey: params.sessionKey,
            });
            await flushTalkRealtimeRelayVoiceWrites({ relaySessionId, connId });
          }
          assertStoreCurrent?.();
          request.sessionMutationAuthorization?.assertCurrent();
          parseRealtimeVoiceAgentConsultArgs(params.args ?? {});
          const origin = assertClientVoiceSessionOpen(
            { agentId, sessionKey: params.sessionKey, voiceSessionId },
            physicalSource,
          );
          if (origin === "relay" && (!relaySessionId || !connId)) {
            throw new Error(
              "relay-owned voice sessions require relaySessionId and connection ownership",
            );
          }
          // Only validated calls may replace the legacy client's connection binding.
          if (connId && !relaySessionId) {
            physicalSource.assertCurrent();
            rememberLegacyVoiceBinding({ connId, sessionKey: params.sessionKey, voiceSessionId });
          }
          return { voiceSessionId, physicalSource };
        } catch (error) {
          errors.push(error);
          throw error;
        } finally {
          await releaseSessionSourceAuthorities([preparedRequester], errors);
        }
      };
      let preparedVoiceSession: Awaited<ReturnType<typeof prepareVoiceSession>>;
      try {
        // Legacy selection and publication share the writer FIFO; relay flushes cannot hold it.
        preparedVoiceSession = relaySessionId
          ? await prepareVoiceSession()
          : await runOpenClawAgentWriteAdmission(voiceOptions, (_identity, assertCurrent) =>
              prepareVoiceSession(assertCurrent),
            );
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
      const { voiceSessionId } = preparedVoiceSession;

      const result = await startTalkRealtimeAgentConsult(request, {
        sessionTarget: target,
        callId: params.callId,
        requestedVoiceSessionId: explicitVoiceSessionId ?? relaySessionId,
        args: params.args ?? {},
        relaySessionId: normalizeOptionalString(params.relaySessionId),
        connId,
        onRunStarted: async (
          runId,
          { assertWorkAdmissionCurrent, physicalSource, onRegistered },
        ) => {
          const release = await registerClientVoiceConsultRun({
            agentId,
            sessionKey: params.sessionKey,
            voiceSessionId,
            runId,
            config: request.context.getRuntimeConfig(),
            physicalSource: physicalSource ?? preparedVoiceSession.physicalSource,
            onRegistered,
            requester: readGatewayRequestMutationAuthority(request).assertCurrent,
            source: {
              storePath: target.storePath,
              assertCurrent: request.sessionMutationAuthorization?.assertCurrent ?? (() => {}),
              prepareWorkerGrant: request.sessionMutationAuthorization?.prepareWorkerGrant,
            },
            assertCurrent: () => {
              assertWorkAdmissionCurrent();
              readGatewayRequestMutationAuthority(request).assertPreparationCurrent();
            },
          });
          try {
            assertWorkAdmissionCurrent();
            request.sessionMutationAuthorization?.assertCurrent();
            return release;
          } catch (error) {
            if (!onRegistered) {
              release();
            }
            throw error;
          }
        },
      });
      if (!result.ok) {
        respond(false, undefined, result.error);
        return;
      }
      respond(
        true,
        {
          runId: result.runId,
          idempotencyKey: result.idempotencyKey,
          agentId,
          agentSessionKey: target.canonicalKey,
        },
        undefined,
      );
    },
  ),
  "talk.client.transcript": defineValidatedGatewayHandler(
    "talk.client.transcript",
    validateTalkClientTranscriptParams,
    async ({ params, respond, context, sessionMutationAuthorization }) => {
      try {
        const config = context.getRuntimeConfig();
        const target =
          sessionMutationAuthorization?.talkSessionTarget ??
          prepareTalkSessionTarget(config, params.sessionKey);
        sessionMutationAuthorization?.assertCurrent();
        await appendClientVoiceTranscript({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionTarget: { sessionKey: target.canonicalKey, storePath: target.storePath },
          voiceSessionId: params.voiceSessionId,
          entryId: params.entryId,
          role: params.role,
          text: params.text,
          ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
          config,
        });
        respond(true, { ok: true }, undefined);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      }
    },
  ),
  "talk.client.close": defineValidatedGatewayHandler(
    "talk.client.close",
    validateTalkClientCloseParams,
    async ({ params, respond, context, client, sessionMutationAuthorization }) => {
      try {
        if (
          await closeTalkClientGatewayControlSession({
            voiceSessionId: params.voiceSessionId,
            sessionKey: params.sessionKey,
            connId: normalizeOptionalString(client?.connId),
          })
        ) {
          respond(true, { ok: true }, undefined);
          return;
        }
        const config = context.getRuntimeConfig();
        const { agentId } =
          sessionMutationAuthorization?.talkSessionTarget ??
          prepareTalkSessionTarget(config, params.sessionKey);
        sessionMutationAuthorization?.assertCurrent();
        await closeClientVoiceSession({
          agentId,
          sessionKey: params.sessionKey,
          voiceSessionId: params.voiceSessionId,
          config,
          expectedOrigin: "client",
        });
        const connId = normalizeOptionalString(client?.connId);
        if (connId) {
          unregisterTalkVoiceSession(params.voiceSessionId, connId, agentId);
          forgetLegacyVoiceBinding(connId, params.sessionKey, params.voiceSessionId);
        }
        respond(true, { ok: true }, undefined);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      }
    },
  ),
  "talk.client.steer": defineValidatedGatewayHandler(
    "talk.client.steer",
    validateTalkClientSteerParams,
    async ({
      params,
      respond,
      client,
      context,
      sessionMutationAuthorization,
      hasCurrentClientAuthority,
    }) => {
      try {
        const target =
          sessionMutationAuthorization?.talkSessionTarget ??
          prepareTalkSessionTarget(context.getRuntimeConfig(), params.sessionKey);
        const runTarget = resolveOwnedActiveTalkRunTarget({
          context,
          clientConnId: client?.connId,
          sessionTarget: target,
          scope: { kind: "session" },
          assertCurrent: sessionMutationAuthorization?.assertCurrent,
        });
        if (runTarget === null) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "talk.client.steer requires an active browser-owned Talk run",
            ),
          );
          return;
        }
        const captured = await captureGatewayOperatorRunAuthority({
          client: client ?? null,
          context,
          hasCurrentClientAuthority,
        });
        try {
          const result = await controlRealtimeVoiceAgentRun({
            sessionKey: target.canonicalKey,
            runTarget,
            getToolAuthorityOverlay: () =>
              prepareTalkClientControlAuthority({
                config: context.getRuntimeConfig(),
                agentRuntime: createPluginRuntime().agent,
                sessionTarget: target,
                source: runTarget.toolAuthoritySource,
                authority: {
                  ...resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
                  operatorAuthority: captured?.authority,
                },
              }),
            text: params.text,
            mode: params.mode,
          });
          respond(true, result, undefined);
        } finally {
          captured?.release();
        }
      } catch (err) {
        respond(false, undefined, talkRequestError(err));
      }
    },
  ),
};
