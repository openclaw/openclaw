import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import { USER_PROFILE_ID_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemPresence } from "../infra/system-presence.js";
// Gateway WebSocket broadcaster.
// Applies event scope guards and slow-consumer handling before sending frames.
import { logRejectedLargePayload } from "../logging/diagnostic-payload.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { queuePluginSessionsChanged } from "../plugins/gateway-events.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { isBrowserCopilotClient } from "../utils/message-channel.js";
import { ADMIN_SCOPE, QUESTIONS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";
import {
  createGatewayLiveTextDelivery,
  type LiveTextPublication,
  type PendingLiveText,
} from "./server-broadcast-live-text.js";
import {
  hasEventScope,
  isSessionReadInvalidation,
  modelMetadataInvalidationFragment,
} from "./server-broadcast-scopes.js";
import type {
  GatewayBroadcastFn,
  GatewayBroadcastOpts,
  GatewayBroadcastToConnIdsFn,
  GatewayBufferedAmountFn,
  GatewayPluginEventBroadcastFn,
  GatewayPluginEventScope,
} from "./server-broadcast-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import { closeGatewayTransportWithGrace } from "./server/connection-transport-close.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, summarizeAgentEventForWsLog } from "./ws-log.js";

// Opt-in scoped clients never receive session-bearing broadcasts without an
// authoritative registry key, including malformed/sessionless agent events.
const log = createSubsystemLogger("gateway/broadcast");

const SESSION_SUBSCRIPTION_EVENTS = new Set([
  "agent",
  "chat",
  "chat.side_result",
  "session.observer",
  // Mirrors the raw agent tool event (full args/result snapshots) onto
  // session subscribers; omitting it here would hand scoped clients the
  // exact payload the registry gate suppresses on the `agent` event.
  "session.tool",
]);

type MessageStringEncoding = {
  values: Map<string, unknown>;
  capture: boolean;
};

const rawJSON = "rawJSON" in JSON && typeof JSON.rawJSON === "function" ? JSON.rawJSON : undefined;

function serializeFrameField(
  name: "payload" | "stateVersion",
  value: unknown,
  messageStrings?: MessageStringEncoding,
): string {
  // Keep the wrapper for toJSON's property key and reuse its serialized field.
  // Only splice wrappers that still start with that field after inherited toJSON.
  const field = { [name]: value };
  let payload: unknown;
  const messageObjects = messageStrings ? new WeakSet<object>() : undefined;
  const fieldJSON = JSON.stringify(
    field,
    messageStrings &&
      function (this: object, key: string, current: unknown): unknown {
        if (this === field) {
          payload = current;
        } else if ((this === payload && key === "message") || messageObjects!.has(this)) {
          if (typeof current === "string" && current.length >= 1024) {
            const encoded = messageStrings.values.get(current);
            if (encoded !== undefined) {
              return encoded;
            }
            if (messageStrings.capture) {
              const prepared = rawJSON!(JSON.stringify(current));
              messageStrings.values.set(current, prepared);
              return prepared;
            }
          } else if (current !== null && typeof current === "object") {
            messageObjects!.add(current);
          }
        }
        return current;
      },
  );
  return fieldJSON.startsWith(`{"${name}":`) ? `,${fieldJSON.slice(1, -1)}` : "";
}

function resolveBroadcastSessionScope(
  payload: unknown,
  explicit: readonly string[] | undefined,
  explicitAgentId: string | undefined,
): { sessionKeys: readonly string[]; agentId?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      sessionKeys: explicit ?? [],
      ...(explicitAgentId ? { agentId: explicitAgentId } : {}),
    };
  }
  const record = payload as {
    sessionKey?: unknown;
    agentId?: unknown;
    suggestion?: { sessionKey?: unknown; agentId?: unknown };
    request?: { sessionKey?: unknown; agentId?: unknown };
  };
  const source = [record, record.suggestion, record.request].find(
    (candidate) => typeof candidate?.sessionKey === "string" && candidate.sessionKey.trim(),
  );
  const sessionKey = typeof source?.sessionKey === "string" ? source.sessionKey.trim() : "";
  const agentId =
    explicitAgentId ??
    (typeof source?.agentId === "string" ? source.agentId.trim() || undefined : undefined);
  return {
    sessionKeys: explicit?.length ? explicit : sessionKey ? [sessionKey] : [],
    ...(agentId ? { agentId } : {}),
  };
}

type FrameFields = {
  eventJSON: string;
  stateVersionFragment: string;
};
type FrameBase = FrameFields & {
  payloadFragment: string;
};
type PreparedFrames = {
  fields?: FrameFields;
  snapshot?: FrameBase;
  delta?: FrameBase;
  reservedBytes?: number;
};
// ws bufferedAmount includes the unmasked server frame's 2/4/10-byte header.
const MAX_SERVER_FRAME_HEADER_BYTES = 10;
// A queued recipient can grow after a merge; JSON may escape each character to six bytes.
const MAX_RECIPIENT_PROFILE_FIELD_BYTES =
  Buffer.byteLength(',"recipientProfileId":""') + USER_PROFILE_ID_MAX_LENGTH * 6;

function frameWithSequence(
  base: FrameFields,
  seq: number,
  payload: string,
  recipientProfileId?: string,
): string {
  const recipient =
    recipientProfileId === undefined
      ? ""
      : `,"recipientProfileId":${JSON.stringify(recipientProfileId)}`;
  return `{"type":"event","event":${base.eventJSON}${payload},"seq":${seq}${base.stateVersionFragment}${recipient}}`;
}

export function createGatewayBroadcaster(params: {
  clients: GatewayClientRegistry;
  // Reused arrays are immutable snapshots; the projection still checks each recipient's authority.
  preparePresenceProjection?: (
    presence: SystemPresence[],
  ) => (client: GatewayWsClient) => SystemPresence[];
  prepareSessionEventProjection?: (
    event: string,
    payload: unknown,
    scope: { sessionKeys: readonly string[]; agentId?: string },
  ) => ((client: GatewayWsClient) => unknown) | undefined;
  sessionMessageSubscribers?: SessionMessageSubscriberRegistry;
  canReceiveSessionEvent?: (
    client: GatewayWsClient,
    sessionKeys: readonly string[],
    agentId?: string,
    event?: string,
    payload?: unknown,
  ) => boolean;
  onBroadcast?: (event: string, payload: unknown, opts?: GatewayBroadcastOpts) => void;
}) {
  const clientSeq = new WeakMap<GatewayWsClient, number>();
  const reportedSlowPayloadClients = new WeakSet<GatewayWsClient>();
  const delivery = createGatewayLiveTextDelivery(params);
  const isCurrent = (predicate?: () => boolean) => {
    try {
      return predicate?.() !== false;
    } catch {
      return false;
    }
  };
  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
    explicitPluginScope?: GatewayPluginEventScope,
    retained?: {
      client: GatewayWsClient;
      socket: GatewayWsClient["socket"];
      frames: PreparedFrames;
      publication?: LiveTextPublication;
    },
  ) => {
    if (!retained && event === "sessions.changed") {
      // Delivery is queued here so process-local handlers run after websocket fanout returns.
      queuePluginSessionsChanged(payload);
    }
    const live = opts?.liveText;
    const publication = retained ? retained.publication : delivery.publish(live);
    if (params.clients.size === 0) {
      return;
    }
    const { sessionKeys, agentId } = resolveBroadcastSessionScope(
      payload,
      opts?.sessionKeys,
      opts?.agentId,
    );
    const isTargeted = Boolean(targetConnIds);
    const presencePayload =
      // SAFETY: Internal presence producers emit { presence: SystemPresence[] }; wire input cannot publish events.
      event === "presence" ? (payload as { presence: SystemPresence[] }) : undefined;
    // The bounded signal has no caller-provided serialization or model/config data.
    const metadataInvalidation =
      event === "chat.metadata.changed" ? modelMetadataInvalidationFragment(payload) : undefined;
    let sessionReadContext: boolean | undefined;
    const hasSessionReadContext = () =>
      (sessionReadContext ??=
        (event === "users.prefs.changed" && isTargeted) ||
        (params.canReceiveSessionEvent !== undefined &&
          sessionKeys.length > 0 &&
          sessionKeys.every((key) => key.trim().length > 0)) ||
        metadataInvalidation !== undefined ||
        isSessionReadInvalidation(event, payload, isTargeted));
    let projectPresence: ((client: GatewayWsClient) => SystemPresence[]) | undefined;
    let presenceFragments: Map<SystemPresence[], string> | undefined;
    let projectSession: ((client: GatewayWsClient) => unknown) | undefined;
    let skipSourcePayload = false;
    let sessionProjectionPrepared = false;
    let outboundEventLogged = false;
    let lastFrameSequence = 0;
    let lastFrameRecipientProfileId: string | undefined;
    let lastFrame: string | undefined;
    let lastPayloadFragment: string | undefined;
    const frames: PreparedFrames = retained?.frames ?? {};
    // Private coalescers preserve inputs; identical pending histories can share this merge.
    let mergedFrames: Map<unknown, { payload: unknown; frames: PreparedFrames }> | undefined;
    const getFrameFields = (): FrameFields =>
      (frames.fields ??= {
        eventJSON: JSON.stringify(event),
        stateVersionFragment:
          opts?.stateVersion === undefined
            ? ""
            : serializeFrameField("stateVersion", opts.stateVersion),
      });
    const frameBaseFor = (value: unknown): FrameBase => ({
      ...getFrameFields(),
      payloadFragment:
        value === payload && metadataInvalidation !== undefined
          ? metadataInvalidation
          : presencePayload
            ? ""
            : serializeFrameField("payload", value),
    });
    // Lazy so filtered-out broadcasts (zero eligible clients) never pay
    // JSON.stringify for the payload.
    const getFrameBase = () => {
      return (frames.snapshot ??= frameBaseFor(payload));
    };
    const sessionSubscriptionVerified = opts?.sessionSubscriptionVerified === true;
    const isSessionSubscriptionEvent = SESSION_SUBSCRIPTION_EVENTS.has(event);
    const sessionMessageSubscribers = params.sessionMessageSubscribers;
    let sessionSubscriberConnIdsByKey: Array<ReadonlySet<string> | undefined> | undefined;
    const recipients = retained
      ? [retained.client]
      : targetConnIds
        ? params.clients.getByConnectionIds(targetConnIds)
        : params.clients;
    // Reuse immutable string encodings, never recipient rows or mutable message objects.
    // Only the first serialized projection populates this fanout-local cache.
    const messageStrings: MessageStringEncoding | undefined =
      rawJSON &&
      event === "session.message" &&
      !retained &&
      (targetConnIds?.size ?? params.clients.size) > 1
        ? { values: new Map(), capture: true }
        : undefined;
    for (const c of recipients) {
      // Closing nodes remain discoverable until their owner drains admitted lifecycle work.
      if (
        !params.clients.has(c) ||
        (retained && c.socket !== retained.socket) ||
        c.invalidated === true ||
        c.socket.readyState !== WEBSOCKET_OPEN_READY_STATE
      ) {
        continue;
      }
      const questionRecipient =
        event === "question.requested" || event === "question.resolved"
          ? opts?.questionRecipient
          : undefined;
      const ownRunQuestion =
        questionRecipient !== undefined &&
        !operatorScopeSatisfied(QUESTIONS_SCOPE, c.connect.scopes ?? []);
      if (!hasEventScope(c, event, explicitPluginScope, ownRunQuestion, hasSessionReadContext)) {
        continue;
      }
      if (
        event === "chat.metadata.changed" &&
        !operatorScopeSatisfied(READ_SCOPE, c.connect.scopes ?? []) &&
        metadataInvalidation === undefined
      ) {
        continue;
      }
      if (questionRecipient && !isCurrent(() => questionRecipient(c))) {
        continue;
      }
      const requiresSessionSubscription =
        event === "session.typing" ||
        sessionSubscriptionVerified ||
        ((isBrowserCopilotClient(c.connect.client) ||
          hasGatewayClientCap(c.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS)) &&
          isSessionSubscriptionEvent);
      if (
        requiresSessionSubscription &&
        !(isTargeted && sessionSubscriptionVerified && !retained)
      ) {
        if (!sessionKeys.length || !sessionMessageSubscribers) {
          continue;
        }
        // Resolve keys lazily to preserve short-circuit order, then reuse their live sets across clients.
        // This avoids repeated normalization and map lookups without snapshotting recipients.
        sessionSubscriberConnIdsByKey ??= [];
        let subscribed = false;
        let sessionKeyIndex = 0;
        for (const sessionKey of sessionKeys) {
          const subscriberConnIds = (sessionSubscriberConnIdsByKey[sessionKeyIndex] ??=
            sessionMessageSubscribers.get(sessionKey));
          if (subscriberConnIds.has(c.connId)) {
            subscribed = true;
            break;
          }
          sessionKeyIndex += 1;
        }
        if (!subscribed) {
          // Scoped clients opt out of cross-session fanout, including critical observer announces.
          // The registry is authoritative; for cap-gated events, unscoped Control UI clients keep full fanout.
          continue;
        }
      }
      if (
        // The question owner consumes prepared sharing and original-source facts together.
        !questionRecipient &&
        sessionKeys.length > 0 &&
        params.canReceiveSessionEvent &&
        !params.canReceiveSessionEvent(c, sessionKeys, agentId, event, payload)
      ) {
        continue;
      }
      // Retirement releases progress without suppressing its captured abort terminal.
      if ((retained && !isCurrent(live?.isCurrent)) || (live?.coalesce && live.group.aborted)) {
        continue;
      }
      if (!outboundEventLogged) {
        outboundEventLogged = true;
        logWs("out", "event", () => {
          const logMeta: Record<string, unknown> = {
            event,
            seq: "per-client",
            clients: params.clients.size,
            targets: targetConnIds ? targetConnIds.size : undefined,
            dropIfSlow: opts?.dropIfSlow,
            presenceVersion: opts?.stateVersion?.presence,
            healthVersion: opts?.stateVersion?.health,
          };
          if (event === "agent") {
            Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
          }
          return logMeta;
        });
      }
      const state = delivery.deliveryFor(c);
      if (live && !live.coalesce) {
        delivery.drain(state, live.group);
      }
      if (state.retired) {
        continue;
      }
      const nextSeq = (clientSeq.get(c) ?? 0) + 1;
      const bufferedAmount = delivery.bufferedBytes(state);
      const slow = bufferedAmount > MAX_BUFFERED_BYTES;
      if (!slow) {
        reportedSlowPayloadClients.delete(c);
      } else if (!reportedSlowPayloadClients.has(c)) {
        reportedSlowPayloadClients.add(c);
        logRejectedLargePayload({
          surface: "gateway.ws.outbound_buffer",
          bytes: bufferedAmount,
          limitBytes: MAX_BUFFERED_BYTES,
          reason: opts?.dropIfSlow ? "ws_send_buffer_drop" : "ws_send_buffer_close",
        });
      }
      if (slow && opts?.dropIfSlow) {
        // Consume the seq for the dropped frame so the client's gap detector
        // sees the loss instead of a silently thinner stream.
        clientSeq.set(c, nextSeq);
        continue;
      }
      if (slow) {
        delivery.retireDelivery(state);
        closeGatewayTransportWithGrace(state.socket, 1008, "slow consumer");
        continue;
      }
      if (!retained && live?.coalesce && state.inFlight > 0) {
        let previous = delivery.pending(state, live.group, live.coalesce.key);
        if (previous && !isCurrent(previous.isCurrent)) {
          delivery.takePending(state, previous);
          previous = undefined;
        }
        try {
          const cached = previous ? mergedFrames?.get(previous.payload) : undefined;
          const nextPayload = cached
            ? cached.payload
            : previous
              ? live.coalesce.merge(previous.payload, payload)
              : payload;
          const prepared = cached?.frames ?? (nextPayload === payload ? frames : {});
          if (previous && !cached && nextPayload !== payload) {
            (mergedFrames ??= new Map()).set(previous.payload, {
              payload: nextPayload,
              frames: prepared,
            });
          }
          // Reserve a possible recovery snapshot without encoding its growing text.
          // Unrelated sends can advance the sequence while this entry waits to drain.
          if (prepared.reservedBytes === undefined) {
            const projection = live.projection;
            const estimator = projection?.snapshotBytes;
            const base =
              estimator && projection
                ? (prepared.delta ??= frameBaseFor(projection.delta(nextPayload)))
                : (prepared.snapshot ??= frameBaseFor(nextPayload));
            const payloadBytes = Buffer.byteLength(base.payloadFragment);
            const fieldPrefixBytes = Buffer.byteLength(',"payload":');
            prepared.fields = getFrameFields();
            prepared.reservedBytes =
              Buffer.byteLength(frameWithSequence(base, Number.MAX_SAFE_INTEGER, "")) +
              (estimator
                ? fieldPrefixBytes + estimator(nextPayload, payloadBytes - fieldPrefixBytes)
                : payloadBytes) +
              MAX_SERVER_FRAME_HEADER_BYTES +
              MAX_RECIPIENT_PROFILE_FIELD_BYTES;
          }
          const bytes = prepared.reservedBytes;
          if (
            delivery.bufferedBytes(state) - (previous?.bytes ?? 0) + bytes <=
            MAX_BUFFERED_BYTES
          ) {
            if (previous) {
              delivery.takePending(state, previous);
            }
            const socket = c.socket;
            const queuedPublication = delivery.coalescePublication(
              publication,
              previous?.publication,
            );
            const entry: PendingLiveText = {
              group: live.group,
              key: live.coalesce.key,
              payload: nextPayload,
              bytes,
              isCurrent: live.isCurrent,
              publication: queuedPublication,
              send: () =>
                broadcastInternal(event, nextPayload, opts, targetConnIds, explicitPluginScope, {
                  client: c,
                  socket,
                  frames: prepared,
                  publication: queuedPublication,
                }),
            };
            delivery.enqueue(state, entry);
            continue;
          }
        } catch (err) {
          log.error(
            `broadcast serialization failed for event ${event}: ${formatErrorMessage(err)}`,
          );
          return;
        }
        // Flush the old deltas, then send this ingress unmerged under the normal slow policy.
        delivery.drain(state, live.group);
        broadcastInternal(event, payload, opts, targetConnIds, explicitPluginScope, {
          client: c,
          socket: c.socket,
          frames,
          publication,
        });
        continue;
      }
      // Build the frame before consuming the seq: a serialization failure
      // (circular/BigInt payload) throws identically for every client, and
      // advancing seqs for a frame that never existed would fire every gap
      // detector at once — a synchronized reconnect storm with no evidence.
      const useDelta = delivery.canSendDelta(state, live, publication);
      const projection = live?.projection;
      const getDeliveryFrameBase = () =>
        useDelta && projection
          ? (frames.delta ??= frameBaseFor(projection.delta(payload)))
          : getFrameBase();
      let frame: string;
      try {
        if (!sessionProjectionPrepared) {
          // Headers precede source hooks and reads performed while preparing projection.
          getFrameFields();
          let canSkipSourcePayload = false;
          if (
            !retained &&
            (event === "session.message" || event === "sessions.changed") &&
            !isProxy(payload) &&
            isRecord(payload)
          ) {
            // Classify without executing getters or Proxy traps.
            const prototype = Object.getPrototypeOf(payload);
            canSkipSourcePayload =
              (prototype === null || prototype === Object.prototype) && !("toJSON" in payload);
          }
          if (!canSkipSourcePayload) {
            getDeliveryFrameBase();
          }
          projectSession = params.prepareSessionEventProjection?.(event, payload, {
            sessionKeys,
            agentId,
          });
          skipSourcePayload = canSkipSourcePayload && projectSession !== undefined;
          sessionProjectionPrepared = true;
        }
        const base = skipSourcePayload ? getFrameFields() : getDeliveryFrameBase();
        let payloadFragment = skipSourcePayload ? "" : getDeliveryFrameBase().payloadFragment;
        if (presencePayload) {
          // Presence contains session references. Only the connection owner's
          // recipient projection may cross this boundary; never send the raw roster.
          if (!params.preparePresenceProjection) {
            throw new Error("presence recipient projection unavailable");
          }
          projectPresence ??= params.preparePresenceProjection(presencePayload.presence);
          // Preserve source reads before checking the recipient's current authority.
          const projectedPayload = { ...presencePayload, presence: projectPresence(c) };
          const reusable =
            Object.keys(projectedPayload).length === 1 && !("toJSON" in projectedPayload);
          const cached = reusable ? presenceFragments?.get(projectedPayload.presence) : undefined;
          payloadFragment = cached ?? serializeFrameField("payload", projectedPayload);
          if (reusable && cached === undefined) {
            (presenceFragments ??= new Map()).set(projectedPayload.presence, payloadFragment);
          }
        }
        if (projectSession) {
          const projected = projectSession(c);
          if (projected === undefined) {
            continue;
          }
          payloadFragment = serializeFrameField(
            "payload",
            projected,
            messageStrings?.capture || messageStrings?.values.size ? messageStrings : undefined,
          );
          if (messageStrings) {
            messageStrings.capture = false;
          }
        }
        // A drained write can refresh the recipient; cache only the profile at this send.
        const recipientProfileId =
          (c.connect.role ?? "operator") === "operator" ? c.preparedRecipientProfileId : undefined;
        if (
          !presencePayload &&
          !projectSession &&
          lastFrame !== undefined &&
          lastPayloadFragment === payloadFragment &&
          lastFrameSequence === nextSeq &&
          lastFrameRecipientProfileId === recipientProfileId
        ) {
          frame = lastFrame;
        } else {
          frame = frameWithSequence(base, nextSeq, payloadFragment, recipientProfileId);
          if (!presencePayload && !projectSession) {
            lastFrameSequence = nextSeq;
            lastFrameRecipientProfileId = recipientProfileId;
            lastPayloadFragment = payloadFragment;
            lastFrame = frame;
          }
        }
      } catch (err) {
        log.error(`broadcast serialization failed for event ${event}: ${formatErrorMessage(err)}`);
        return;
      }
      // Targeted frames ride the same per-client sequence as fanout frames:
      // an unstamped frame is invisible to the client's gap detector, so a
      // drop between two targeted sends would go unnoticed forever.
      clientSeq.set(c, nextSeq);
      delivery.recordReceipt(state, sessionKeys, live, publication);
      state.inFlight += 1;
      let finished = false;
      const sent = (err?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        state.inFlight -= 1;
        // ws fails every queued write when compression loses its socket. Settle
        // each callback, but retire this delivery generation only once.
        if (state.retired) {
          return;
        }
        if (err) {
          delivery.retireDelivery(state);
          log.error(`broadcast send failed conn=${c.connId}: ${formatErrorMessage(err)}`, {
            event,
          });
          state.socket.terminate();
        } else {
          delivery.drain(state);
        }
      };
      try {
        state.socket.send(frame, sent);
      } catch (err) {
        sent(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const broadcast: GatewayBroadcastFn = (event, payload, opts) => {
    params.onBroadcast?.(event, payload, opts);
    broadcastInternal(event, payload, opts);
  };

  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    broadcastInternal(event, payload, opts, connIds);
  };

  const getBufferedAmount: GatewayBufferedAmountFn = (connId) => {
    const client = params.clients.getByConnectionId(connId);
    if (!client || client.invalidated || client.socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
      return undefined;
    }
    const state = delivery.deliveryFor(client);
    // Failed compression retains ws's queued byte count after transport retirement.
    return state.retired ? undefined : delivery.bufferedBytes(state);
  };

  const broadcastPluginEvent: GatewayPluginEventBroadcastFn = (event, payload, scope) => {
    if (!event.startsWith("plugin.") || event.startsWith("plugin.approval.")) {
      throw new Error(`invalid plugin gateway event: ${event}`);
    }
    if (scope !== READ_SCOPE && scope !== WRITE_SCOPE && scope !== ADMIN_SCOPE) {
      throw new Error("invalid plugin gateway event scope");
    }
    broadcastInternal(event, payload, undefined, undefined, scope);
  };

  return { broadcast, broadcastToConnIds, broadcastPluginEvent, getBufferedAmount };
}
