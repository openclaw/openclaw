import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { resolvePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import type {
  RpcSourceAdapter,
  RpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { registerRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { registerChatAbortController } from "../chat-abort.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../test-helpers.rpc-source.js";

/** Use the fixture's physical partition, not a logical key as a store owner. */
export function captureRpcTargetForTest(scope: {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  storeScope?: string;
}) {
  const cfg = getRuntimeConfig();
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey: scope.sessionKey,
    agentId: scope.agentId,
  });
  return captureSessionTarget({
    storeScope:
      scope.storeScope ??
      resolvePhysicalSessionStorePath({ agentId, sessionKey: canonicalKey }, cfg),
    sessionKey: canonicalKey,
    aliases: [scope.sessionKey],
    incarnation: scope.sessionId,
    agentId,
  });
}

/** Isolated dispatch-edge tests still use the real registration and forwarding signal. */
export function registerRpcSourceForTest(
  params: Omit<Parameters<typeof registerChatAbortController>[0], "target" | "timeoutMs"> & {
    storeScope?: string;
  },
) {
  const registration = registerChatAbortController({
    ...params,
    timeoutMs: 60_000,
    target: captureSessionTarget({
      storeScope: params.storeScope ?? "/synthetic/rpc-registration/" + randomUUID(),
      sessionKey: params.sessionKey ?? "agent:main:fixture",
      incarnation: params.sessionId,
      agentId: params.agentId,
    }),
  });
  if (!registration.registered) {
    throw new Error("Expected a registered fixture source");
  }
  onTestFinished(() => {
    registration.entry?.input.claim?.operation?.complete();
    registration.cleanup();
  });
  return registration;
}

/** Projection-only fixtures still acquire an actual selector claim and operation. */
export async function createActiveRpcSourceForTest(
  metadata: Partial<RpcSourceAdapter> & { projectSessionActive?: boolean } = {},
  identity: Partial<RpcSourceIdentity> & { runId?: string; storeScope?: string } = {},
) {
  const ref = createRpcSourceForTest(metadata, identity);
  const release = await claimRpcSourceForTest(ref);
  return Object.assign(ref, { release });
}

/** Registers an active projection through the controller-owned protocol index. */
export async function registerActiveRpcSourceForTest(
  runId: string,
  metadata: Partial<RpcSourceAdapter> & { projectSessionActive?: boolean } = {},
  identity: Partial<RpcSourceIdentity> & { storeScope?: string } = {},
) {
  const ref = await createActiveRpcSourceForTest(metadata, { ...identity, runId });
  registerRpcSource(runId, ref);
  return ref;
}
