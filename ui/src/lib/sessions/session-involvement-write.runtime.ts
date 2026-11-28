import type { SessionsSetInvolvementParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import {
  resolvePendingConversation,
  type createOptimisticRowField,
} from "./session-pending-rows.ts";

const involvementWritesByHost = new WeakMap<SessionMutationsHost, Map<string, Promise<void>>>();

export async function setSessionInvolvement(
  host: SessionMutationsHost,
  involvement: ReturnType<typeof createOptimisticRowField<"hiddenFromInvolvingMe">>,
  params: SessionsSetInvolvementParams,
): Promise<boolean> {
  const scope = host.connection.capture();
  const conversation = resolvePendingConversation(host.snapshot(), params.key, params.agentId);
  if (!scope || !conversation) {
    return false;
  }
  const target = { ...conversation, sessionId: params.expectedSessionId };
  const confirm = host.capturePatchFields(target);
  const token = involvement.prepare(() => params.hidden)(target);
  const settle = (confirmed: boolean) => {
    const current = host.connection.isCurrent(scope);
    if (token) {
      involvement.settle(target, token, confirmed, current);
    }
  };
  if (!host.connection.isCurrent(scope)) {
    settle(false);
    return false;
  }
  let writes = involvementWritesByHost.get(host);
  if (!writes) {
    writes = new Map();
    involvementWritesByHost.set(host, writes);
  }
  // Show and Hide may come from different menus. Preserve click order on the wire.
  const key = JSON.stringify([scope.epoch, target.identity, target.sessionId]);
  const previous = writes.get(key);
  const dispatch = async () => {
    if (host.connection.isCurrent(scope)) {
      await scope.client.request("sessions.setInvolvement", params);
      confirm({
        ...target,
        updatedAt: null,
        readCutoff: host.readRevision(),
        fields: { hiddenFromInvolvingMe: params.hidden },
      });
    }
  };
  const write = previous ? previous.then(dispatch, dispatch) : dispatch();
  writes.set(key, write);
  const latest = () => host.connection.isCurrent(scope) && writes.get(key) === write;
  let confirmed = false;
  try {
    await write;
    confirmed = true;
    return latest();
  } catch (error) {
    if (latest()) {
      throw error;
    }
    return false;
  } finally {
    if (writes.get(key) === write) {
      writes.delete(key);
    }
    settle(confirmed);
  }
}
