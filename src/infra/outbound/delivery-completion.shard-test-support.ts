import path from "node:path";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import { capturePendingFinalRecoverySource } from "../../agents/pending-final-recovery-source.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

export function registerMatrix(outbound: ChannelOutboundAdapter = matrixOutboundForQueueTest) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
      },
    ]),
  );
}

export function installRecoveryHooks(register = true, stubState = true) {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let deliver: typeof import("./deliver.js").deliverOutboundPayloads;
  beforeAll(async () => {
    ({ deliverOutboundPayloads: deliver } = await import("./deliver.js"));
  });
  beforeEach(() => {
    if (stubState) {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    }
    if (register) {
      registerMatrix();
    }
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    if (stubState) {
      vi.unstubAllEnvs();
    }
  });
  return { ...fixtures, deliver: (...args: Parameters<typeof deliver>) => deliver(...args) };
}

export async function seedRecoverySession(
  tmpDir: string,
  name: string,
  sourceRunId: string,
  recoveryRunId: string,
  extra: Partial<SessionEntry> = {},
) {
  const scope = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:${name}`,
    storePath: path.join(tmpDir, "sessions.json"),
  };
  const context = { channel: "matrix", to: "!original:example" };
  await replaceSessionEntry(scope, {
    sessionId: "session",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: recoveryRunId,
    restartRecoveryDeliverySourceRunId: sourceRunId,
    restartRecoveryDeliveryContext: context,
    ...extra,
  });
  return { scope, context, entry: loadSessionEntry(scope)! };
}

export async function markFinal(
  scope: { agentId: string; sessionKey: string; storePath: string },
  entry: SessionEntry,
  payloads: ReplyPayload[],
  deliveryContext: { channel: string; to: string; accountId?: string; threadId?: string },
) {
  await persistPendingFinalDeliveryMarker({
    ...scope,
    admittedRecoverySource: capturePendingFinalRecoverySource(entry),
    deliver: true,
    sessionStore: { [scope.sessionKey]: entry },
    sessionEntry: entry,
    suppressVisibleSessionEffects: false,
    sessionReboundDuringRun: false,
    payloads,
    deliveryContext,
    runOwnedSessionId: entry.sessionId,
  });
}
