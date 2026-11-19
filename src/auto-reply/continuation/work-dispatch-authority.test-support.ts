import { expect } from "vitest";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import { runWithOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import {
  bindPreparedReplyDispatchRuntime,
  getPreparedReplyDispatchRuntime,
} from "../reply/prepared-reply-dispatch-context.js";
import { dispatchPendingContinuationWorkFromDetachedCallback } from "./work-dispatch.js";
import { enqueuePendingWork } from "./work-store.test-support.js";

type ObservedAuthority = { direct: boolean; requestClient: boolean; resolver: boolean };

export async function runDetachedAuthorityFossil(params: {
  mockSessionStore: Record<string, unknown>;
  observedDetachedAuthority: ObservedAuthority[];
  turnGrants: unknown[];
}): Promise<void> {
  const sessionKey = "agent:main:detached-authority";
  params.mockSessionStore[sessionKey] = { sessionKey };
  const resolveGatewayContext = () => undefined;
  params.observedDetachedAuthority.push({ direct: true, requestClient: true, resolver: false });
  await enqueuePendingWork({
    sessionKey,
    hop: 1,
    delayMs: 0,
    electedAt: Date.now(),
    dueAt: Date.now(),
    maxChainLength: 8,
    reason: "detached authority",
  });
  await runWithOperatorToolGatewayAuthority(
    {
      assertCurrent: () => {
        throw new Error("Gateway caller authority is no longer active.");
      },
    } as unknown as Parameters<typeof runWithOperatorToolGatewayAuthority>[0],
    () =>
      withPluginRuntimeGatewayRequestScope(
        {
          isWebchatConnect: () => false,
          resolveGatewayContext,
          client: { authenticatedUserProfile: { profileId: "owner" } } as Parameters<
            typeof withPluginRuntimeGatewayRequestScope
          >[0]["client"],
          hasCurrentClientAuthority: () => false,
        },
        async () => await dispatchPendingContinuationWorkFromDetachedCallback({ sessionKey }),
      ),
  );
  expect(params.observedDetachedAuthority).toEqual([
    { direct: false, requestClient: false, resolver: true },
  ]);
  expect(params.turnGrants).toHaveLength(1);
}

type ObservedGenerations = { prepared: boolean; pluginRegistry: boolean; dispatchRuntime: boolean };

/** What the wake's reply path sees of the admitted generations it was armed under. */
export function observeAdmittedGenerations(): ObservedGenerations {
  return {
    prepared: getPreparedModelRuntimePluginGeneration() !== undefined,
    pluginRegistry: getPluginRuntimeGenerationRegistry() !== undefined,
    dispatchRuntime: getPreparedReplyDispatchRuntime() !== undefined,
  };
}

/**
 * #1550: a work timer armed inside a turn inherits that turn's admitted generations. The
 * turn's lease closes before the wake fires, so the wake must re-admit on the current
 * generation rather than carry one it can no longer borrow.
 */
export async function runDetachedGenerationFossil(params: {
  mockSessionStore: Record<string, unknown>;
  observedDetachedGenerations: ObservedGenerations[];
  turnGrants: unknown[];
}): Promise<void> {
  const sessionKey = "agent:main:detached-generation";
  params.mockSessionStore[sessionKey] = { sessionKey };
  params.observedDetachedGenerations.push({
    prepared: true,
    pluginRegistry: true,
    dispatchRuntime: true,
  });
  await enqueuePendingWork({
    sessionKey,
    hop: 2,
    delayMs: 0,
    electedAt: Date.now(),
    dueAt: Date.now(),
    maxChainLength: 8,
    reason: "detached generation",
  });
  // A closed turn lease: the generation is still in the frame, its borrow is gone. The arming
  // request's prepared reply dispatch runtime pins that generation too (get-reply-run acquires on it).
  const closedTurnGeneration = {
    remoteCatalog: null,
  } as unknown as PreparedModelRuntimePluginGeneration;
  const armingDispatchRuntime = { pluginGeneration: closedTurnGeneration } as unknown as Parameters<
    typeof bindPreparedReplyDispatchRuntime
  >[0];
  await withPreparedModelRuntimePluginGenerationScope(
    closedTurnGeneration,
    () =>
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          pluginRegistry: createEmptyPluginRegistry(),
        },
        bindPreparedReplyDispatchRuntime(armingDispatchRuntime, async () => {
          // Control: the arming frame does carry all three.
          expect(observeAdmittedGenerations()).toEqual({
            prepared: true,
            pluginRegistry: true,
            dispatchRuntime: true,
          });
          await dispatchPendingContinuationWorkFromDetachedCallback({ sessionKey });
        }),
      ),
    () => undefined,
  );
  expect(params.observedDetachedGenerations).toEqual([
    { prepared: false, pluginRegistry: false, dispatchRuntime: false },
  ]);
  expect(params.turnGrants).toHaveLength(1);
}
