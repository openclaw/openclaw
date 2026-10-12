import { isDeepStrictEqual } from "node:util";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import type {
  NodeEvent,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import type { loadGatewaySessionEntry } from "./session-utils-store.js";

export type NodeEventSessionSource = {
  loaded: ReturnType<typeof loadGatewaySessionEntry>;
  assertCurrent(this: void): void;
  pending: Promise<unknown>[];
};

export async function isNodeEventConnectionCurrent(opts?: {
  isConnectionCurrent?: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (!opts?.isConnectionCurrent) {
    return true;
  }
  try {
    return await opts.isConnectionCurrent();
  } catch {
    return false;
  }
}

export function pairingChangedResult(event: string): NodeEventHandleResult {
  return { ok: true, event, handled: false, reason: "pairing_changed" };
}

export function parseNodeEventPayload(payloadJSON?: string | null): Record<string, unknown> | null {
  return payloadJSON ? asNullableObjectRecord(safeParseJson(payloadJSON)) : null;
}

/** Keep prepared private authority and every accepted consumer with the captured actor. */
export async function withNodeEventSessionSource(
  evt: NodeEvent,
  opts: NodeEventHandlerOptions | undefined,
  consume: (
    opts: NodeEventHandlerOptions | undefined,
    source?: NodeEventSessionSource,
  ) => Promise<NodeEventHandleResult | undefined>,
): Promise<NodeEventHandleResult | undefined> {
  const requestedKey = normalizeOptionalString(parseNodeEventPayload(evt.payloadJSON)?.sessionKey);
  const namespace =
    requestedKey &&
    ["voice.transcript", "agent.request", "notifications.changed"].includes(evt.event)
      ? captureSessionActorStorageOwner(
          { sessionKey: requestedKey },
          { assertCurrent() {}, authorize() {} },
        )
      : undefined;
  if (!namespace || !requestedKey) {
    return consume(opts);
  }
  if (!(await isNodeEventConnectionCurrent(opts))) {
    return pairingChangedResult(evt.event);
  }
  const binding = await acquireSessionActorStorage(
    { sessionKey: requestedKey },
    {
      lifetime: {
        assertCurrent: () => namespace.authority.assertCurrent(),
        assertReadable: () => namespace.authority.assertCurrent(),
      },
      authority: namespace.authority,
    },
  );
  if (!binding) {
    return { ok: true, event: evt.event, handled: false, reason: "session_missing" };
  }
  try {
    return await runWithSessionActorStorage(binding, async () => {
      const entry = binding.actor.snapshot(binding.authority)?.entry;
      if (!entry) {
        return { ok: true, event: evt.event, handled: false, reason: "session_missing" } as const;
      }
      const assertCurrent = () => {
        const current = binding.actor.snapshot(binding.authority)?.entry;
        if (
          current?.agentHarnessId !== entry.agentHarnessId ||
          !isDeepStrictEqual(current?.delivery, entry.delivery)
        ) {
          throw new Error("Node event session authority changed");
        }
      };
      const pending: Promise<unknown>[] = [];
      try {
        return await consume(
          {
            ...opts,
            isConnectionCurrent: async () => {
              const current = await isNodeEventConnectionCurrent(opts);
              assertCurrent();
              return current;
            },
          },
          {
            loaded: {
              cfg: getRuntimeConfig(),
              agentId: binding.agentId,
              storePath: binding.path,
              canonicalKey: requestedKey,
              storeKeys: [requestedKey],
              store: { [requestedKey]: entry },
              legacyKey: undefined,
              entry,
            },
            assertCurrent,
            pending,
          },
        );
      } finally {
        for (const work of pending) {
          await Promise.allSettled([work]);
        }
      }
    });
  } finally {
    await binding.actor.release();
  }
}
