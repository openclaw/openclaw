import type { WorkerSessionsSendParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { InheritedToolPolicySourceCapture } from "../../agents/inherited-tool-policy.schema.js";
import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import {
  bindInProcessSessionSendPolicy,
  readInProcessSessionSendPolicy,
} from "../in-process-session-send-policy.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import { WorkerSessionToolOutcomeUnknownError } from "./worker-session-tool-result.js";
import {
  resolveWorkerSessionToolTarget as exactAuthorizedTarget,
  type WorkerSessionToolSource as ExactSource,
  type WorkerSessionToolRowRead,
  withPreparedWorkerSessionToolRows,
  workerSessionRelationKey as relationKey,
} from "./worker-session-tool-topology.js";

export async function executeWorkerSessionSend(operation: {
  source: ExactSource;
  resolveGatewayContext: GatewayContextResolver;
  readSourceEntry: WorkerSessionToolRowRead;
  request: WorkerSessionsSendParams;
  idempotencyKey: string;
  assertSource: () => void;
  captureInheritedToolPolicyForDelegation: InheritedToolPolicySourceCapture;
  callGateway: AgentToolGatewayRequestCaller;
  signal?: AbortSignal;
}) {
  return withPreparedWorkerSessionToolRows({
    resolveGatewayContext: operation.resolveGatewayContext,
    sessionKeys: [operation.request.sessionKey],
    assertCurrent: operation.assertSource,
    consume: async (readTarget) => {
      const targetEntry = readTarget(operation.request.sessionKey).entry;
      const parent =
        relationKey(operation.source.entry.parentSessionKey) ??
        relationKey(operation.source.entry.spawnedBy);
      const targetParent =
        relationKey(targetEntry?.parentSessionKey) ?? relationKey(targetEntry?.spawnedBy);
      const run = async (readParent?: WorkerSessionToolRowRead) => {
        const readEntry: WorkerSessionToolRowRead = (key, options) =>
          key === operation.source.sessionKey
            ? operation.readSourceEntry(key, options)
            : key === operation.request.sessionKey
              ? readTarget(key, options)
              : readParent
                ? readParent(key, options)
                : readTarget(key, options);
        const config = getRuntimeConfig();
        const target = exactAuthorizedTarget({
          source: operation.source,
          requestedSessionKey: operation.request.sessionKey,
          readEntry,
        });
        const executeFencedSend = async () => {
          const assertCurrentTarget = () => {
            const currentTarget = exactAuthorizedTarget({
              source: operation.source,
              requestedSessionKey: operation.request.sessionKey,
              readEntry,
            });
            if (
              currentTarget.sessionId !== target.sessionId ||
              currentTarget.topologyParent?.sessionKey !== target.topologyParent?.sessionKey ||
              currentTarget.topologyParent?.sessionId !== target.topologyParent?.sessionId
            ) {
              throw new Error("Worker sessions_send target incarnation changed");
            }
          };
          assertCurrentTarget();
          const tool = createSessionsSendTool({
            agentSessionKey: operation.source.sessionKey,
            agentChannel: sessionDeliveryChannel(operation.source.entry),
            expectedTargetSessionId: target.sessionId,
            idempotencyKey: operation.idempotencyKey,
            config,
            captureInheritedToolPolicyForDelegation:
              operation.captureInheritedToolPolicyForDelegation,
            ...(operation.signal ? { signal: operation.signal } : {}),
            callGateway: (request) => {
              assertCurrentTarget();
              return operation.callGateway(
                bindInProcessSessionSendPolicy(
                  {
                    ...request,
                    assertDispatchCurrent: () => {
                      assertCurrentTarget();
                      request.assertDispatchCurrent?.();
                    },
                  },
                  readInProcessSessionSendPolicy(request),
                ),
              );
            },
          });
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              operation.assertSource();
              assertCurrentTarget();
              return await tool.execute(operation.request.toolCallId, {
                sessionKey: target.sessionKey,
                message: operation.request.message,
                ...(operation.request.timeoutSeconds === undefined
                  ? {}
                  : { timeoutSeconds: operation.request.timeoutSeconds }),
              });
            } catch (error) {
              if (attempt === 1) {
                throw new WorkerSessionToolOutcomeUnknownError(error);
              }
            }
          }
          throw new WorkerSessionToolOutcomeUnknownError(
            new Error("Worker sessions_send did not return a result"),
          );
        };
        const topologyParent = target.topologyParent;
        if (!topologyParent) {
          return await executeFencedSend();
        }
        // Sibling authority exists only while the exact shared parent exists. Hold
        // that third incarnation through target admission and the message effect.
        return await runWithScopedSessionAccess({
          cfg: config,
          expectedSessionId: topologyParent.sessionId,
          targetSessionKey: topologyParent.sessionKey,
          ...(operation.signal ? { signal: operation.signal } : {}),
          run: executeFencedSend,
        });
      };
      return parent && parent === targetParent && parent !== operation.request.sessionKey
        ? withPreparedWorkerSessionToolRows({
            resolveGatewayContext: operation.resolveGatewayContext,
            sessionKeys: [parent],
            assertCurrent: operation.assertSource,
            consume: run,
          })
        : run();
    },
  });
}
