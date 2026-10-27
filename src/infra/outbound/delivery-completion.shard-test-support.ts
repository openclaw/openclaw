import path from "node:path";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { persistPendingFinalDeliveryMarker } from "../../agents/pending-final-delivery-marker.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

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
  let send: typeof import("../../plugin-sdk/channel-outbound.js").sendDurableMessageBatch;
  beforeAll(async () => {
    ({ sendDurableMessageBatch: send } = await import("../../plugin-sdk/channel-outbound.js"));
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
  return {
    ...fixtures,
    deliver: async ({
      queuePolicy,
      ...params
    }: Omit<Parameters<DeliverFn>[0], "bestEffort" | "onDeliveryIntent">) => {
      const result = await send({ ...params, durability: queuePolicy ?? "best_effort" });
      if (result.status === "failed" || result.status === "partial_failed") {
        throw result.error;
      }
      return result.results;
    },
    recover: (run: DeliverFn) =>
      recoverPendingDeliveries({
        cfg: {},
        stateDir: fixtures.tmpDir(),
        log: createRecoveryLog(),
        deliver: run,
      }),
  };
}

export async function seedDeliverySession(tmpDir: string, extra: Partial<SessionEntry> = {}) {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:requester",
    storePath: path.join(tmpDir, "sessions.json"),
  };
  const context = { channel: "matrix", to: "!original:example" };
  await replaceSessionEntry(scope, {
    sessionId: "session",
    updatedAt: 1,
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
