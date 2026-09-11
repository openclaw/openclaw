// Gateway owner for live local sessions. Opens one plugin-owned node duplex per
// enrolled (device, source), projects the device's native threads into ordinary
// session rows the team can read, and relays team input back with a recorded
// outcome. The Gateway never runs these turns and never holds device credentials.
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import {
  listLocalSessionMirrorCheckpoints,
  readLocalSessionInput,
  recordLocalSessionInput,
  settleLocalSessionInput,
} from "../../config/sessions/session-local-store.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import {
  decodeLocalSessionSourceFrame,
  encodeLocalSessionFrame,
  type LocalSessionEnrollmentSummary,
  type LocalSessionGatewayFrame,
  type LocalSessionInputMode,
  type LocalSessionRecord,
  type LocalSessionSourceFrame,
  type LocalSessionSourceSessionFrame,
} from "../../sessions/local-session-source-protocol.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import {
  listLocalSessionEnrollments,
  listLocalSessionExclusions,
  setLocalSessionExclusion,
  transitionLocalSessionEnrollment,
  type LocalSessionEnrollment,
} from "../../state/local-session-enrollments.js";
import type { NodeSession } from "../node-registry.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import { createGatewayNodesRuntime } from "../server-plugins.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  appendMirroredRecords,
  buildLocalSessionKey,
  ensureLocalSessionThread,
  type LiveThread,
} from "./bridge-mirror.js";
import {
  listRegisteredLocalSessionSources,
  type LocalSessionBridge,
  type LocalSessionBridgeDeps,
  type LocalSessionInputReceipt,
  type LocalSessionSourceDescriptor,
  type LocalSessionStatus,
} from "./bridge.js";

const log = createSubsystemLogger("gateway/local-sessions");
/** One duplex frame may carry a full bootstrap page of clipped records. */
const LOCAL_SESSION_DUPLEX_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

type SourceConnection = {
  key: string;
  deviceId: string;
  source: LocalSessionSourceDescriptor;
  enrollment: LocalSessionEnrollment;
  inputModes: LocalSessionInputMode[];
  helloReceived: boolean;
  threads: Map<string, LiveThread>;
  /** Threads unshared for good; a frame that races the device's unshare must not re-create the row. */
  excludedThreadIds: Set<string>;
  /** inputId -> session key, so a late result still settles the right ledger. */
  pendingInputs: Map<string, { sessionKey: string; agentId: string; storePath: string }>;
  send: (frame: LocalSessionGatewayFrame) => Promise<void>;
  close: () => void;
};

function connectionKey(deviceId: string, sourceId: string): string {
  return `${deviceId}\u0000${sourceId}`;
}

function enrollmentSummary(enrollment: LocalSessionEnrollment): LocalSessionEnrollmentSummary {
  return {
    enrollmentId: enrollment.enrollmentId,
    agentId: enrollment.agentId,
    requester: { profileId: enrollment.ownerProfileId, displayName: enrollment.ownerLabel },
    audienceLabel: "everyone on this Gateway with write access",
    ...(enrollment.setupId ? { setupId: enrollment.setupId } : {}),
  };
}

export class LocalSessionBridgeRuntime implements LocalSessionBridge {
  private readonly connections = new Map<string, SourceConnection>();
  /** Channel keys whose open is in flight; cleared once the channel is registered or failed. */
  private readonly opening = new Set<string>();
  private readonly threadsBySessionKey = new Map<
    string,
    { connection: SourceConnection; thread: LiveThread }
  >();
  private readonly connectedNodes = new Map<string, NodeSession>();
  private readonly nodes: PluginRuntime["nodes"];

  constructor(private readonly deps: LocalSessionBridgeDeps) {
    this.nodes = createGatewayNodesRuntime(deps.resolveGatewayContext, deps.signal);
    deps.signal.addEventListener("abort", () => this.stop(), { once: true });
    // The runtime loads lazily; devices that connected before it was ready are
    // reconciled here so an early node never waits for its next reconnect.
    const connected = deps.resolveGatewayContext()?.nodeRegistry.listConnected() ?? [];
    log.info(`local session bridge started; ${connected.length} connected node(s)`);
    for (const node of connected) {
      this.onNodeConnected(node);
    }
  }

  stop(): void {
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();
  }

  onNodeConnected(session: NodeSession): void {
    log.info(`local session bridge: node ${session.nodeId.slice(0, 8)} connected`);
    this.connectedNodes.set(session.nodeId, session);
    void this.reconcileDevice(session.nodeId);
  }

  onNodeDisconnected(nodeId: string): void {
    this.connectedNodes.delete(nodeId);
    // Snapshot first: dropConnection deletes from the map being walked.
    for (const connection of Array.from(this.connections.values())) {
      if (connection.deviceId === nodeId) {
        this.dropConnection(connection, "device disconnected");
      }
    }
  }

  /** Enrollment rows changed (request, revoke); (re)open or close the device channel. */
  onEnrollmentChanged(enrollment: LocalSessionEnrollment): void {
    const existing = this.connections.get(connectionKey(enrollment.deviceId, enrollment.sourceId));
    if (existing && existing.enrollment.enrollmentId === enrollment.enrollmentId) {
      if (enrollment.state === "revoked" || enrollment.state === "declined") {
        void existing.send({ type: "revoke" }).catch(() => {});
        this.dropConnection(existing, `enrollment ${enrollment.state}`);
      }
      return;
    }
    if (existing && (enrollment.state === "pending" || enrollment.state === "active")) {
      // A newer request revoked the row behind this channel
      // (createLocalSessionEnrollment); its authorization must not outlive it.
      void existing.send({ type: "revoke" }).catch(() => {});
      this.dropConnection(existing, "enrollment replaced");
    }
    void this.reconcileDevice(enrollment.deviceId);
  }

  getStatus(sessionKey: string): LocalSessionStatus | undefined {
    const live = this.threadsBySessionKey.get(sessionKey);
    if (!live) {
      return undefined;
    }
    const { connection, thread } = live;
    return {
      sourceId: connection.source.sourceId,
      sourceLabel: connection.source.label,
      deviceId: connection.deviceId,
      threadId: thread.threadId,
      ownerProfileId: connection.enrollment.ownerProfileId,
      ownerLabel: connection.enrollment.ownerLabel,
      connected: true,
      state: thread.state,
      canInput: thread.canInput && connection.inputModes.length > 0,
      inputModes: connection.inputModes,
      ...(thread.reason ? { reason: thread.reason } : {}),
      ...(thread.earliestSeq !== undefined ? { earliestSeq: thread.earliestSeq } : {}),
    };
  }

  /** Offline projection for a stored row whose device is not connected right now. */
  describeOffline(entry: SessionEntry): LocalSessionStatus | undefined {
    const source = entry.localSource;
    if (!source) {
      return undefined;
    }
    const enrollment = listLocalSessionEnrollments({
      deviceId: source.deviceId,
      sourceId: source.sourceId,
    })[0];
    const descriptor = listRegisteredLocalSessionSources().find(
      (candidate) => candidate.sourceId === source.sourceId,
    );
    return {
      sourceId: source.sourceId,
      sourceLabel: descriptor?.label ?? source.sourceId,
      deviceId: source.deviceId,
      threadId: source.threadId,
      ownerProfileId: enrollment?.ownerProfileId ?? "",
      ownerLabel: enrollment?.ownerLabel ?? "",
      connected: false,
      state: "unavailable",
      canInput: false,
      inputModes: [],
      reason:
        enrollment?.state === "active"
          ? "device is offline"
          : `sharing ${enrollment?.state ?? "ended"} for this device`,
    };
  }

  async submitInput(params: {
    entry: SessionEntry;
    sessionKey: string;
    agentId: string;
    storePath: string;
    /** The caller's idempotency key: a retried request must not relay twice. */
    inputId: string;
    text: string;
    mode: LocalSessionInputMode;
    sender: { profileId?: string; displayName: string };
    participant?: SessionParticipantIdentity;
  }): Promise<LocalSessionInputReceipt> {
    const live = this.threadsBySessionKey.get(params.sessionKey);
    const { inputId } = params;
    const scope = {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    };
    const sessionId = params.entry.sessionId;
    if (!sessionId) {
      return { inputId, state: "rejected", reason: "session has no active transcript" };
    }
    const previous = readLocalSessionInput(scope, inputId);
    if (previous) {
      // The device may already be running this instruction; hand back the
      // recorded outcome rather than sending a second copy.
      if (previous.sessionKey !== params.sessionKey) {
        return { inputId, state: "rejected", reason: "idempotency key already used elsewhere" };
      }
      return {
        inputId,
        state: previous.state,
        ...(previous.reason ? { reason: previous.reason } : {}),
      };
    }
    recordLocalSessionInput(scope, {
      inputId,
      sessionKey: params.sessionKey,
      sessionId,
      ...(params.sender.profileId ? { senderProfileId: params.sender.profileId } : {}),
      senderLabel: params.sender.displayName,
      queueMode: params.mode,
      text: params.text,
    });
    const reject = (reason: string): LocalSessionInputReceipt => {
      settleLocalSessionInput(scope, { inputId, state: "rejected", reason });
      this.publishReceipt(params.sessionKey, params.agentId, {
        inputId,
        state: "rejected",
        reason,
      });
      return { inputId, state: "rejected", reason };
    };
    if (!live) {
      return reject(this.describeOffline(params.entry)?.reason ?? "device is offline");
    }
    const { connection, thread } = live;
    if (!thread.canInput) {
      return reject(thread.reason ?? "session is not accepting input");
    }
    if (!connection.inputModes.includes(params.mode)) {
      return reject(`this source does not support "${params.mode}" input`);
    }
    connection.pendingInputs.set(inputId, scope);
    try {
      await connection.send({
        type: "input",
        inputId,
        threadId: thread.threadId,
        mode: params.mode,
        text: params.text,
        sender: params.sender,
      });
    } catch (error) {
      connection.pendingInputs.delete(inputId);
      return reject(`could not reach the device: ${String(error)}`);
    }
    if (params.participant) {
      recordSessionParticipantBestEffort({
        identity: params.participant,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
    }
    return { inputId, state: "accepted" };
  }

  async unshare(params: { entry: SessionEntry; byProfileId: string }): Promise<void> {
    const source = params.entry.localSource;
    if (!source) {
      return;
    }
    setLocalSessionExclusion({
      deviceId: source.deviceId,
      sourceId: source.sourceId,
      threadId: source.threadId,
      excluded: true,
      byProfileId: params.byProfileId,
    });
    const connection = this.connections.get(connectionKey(source.deviceId, source.sourceId));
    if (!connection) {
      return;
    }
    // The caller deletes the projected row next; drop the live mapping first so
    // records still in flight cannot land in (or re-create) it.
    connection.excludedThreadIds.add(source.threadId);
    const thread = connection.threads.get(source.threadId);
    if (thread) {
      connection.threads.delete(source.threadId);
      this.threadsBySessionKey.delete(thread.sessionKey);
    }
    await connection.send({ type: "unshare", threadId: source.threadId }).catch(() => {});
  }

  private async reconcileDevice(deviceId: string): Promise<void> {
    const node = this.connectedNodes.get(deviceId);
    if (!node) {
      log.info(`local session bridge: device ${deviceId.slice(0, 8)} is not connected; waiting`);
      return;
    }
    const now = Date.now();
    const enrollments = listLocalSessionEnrollments({ deviceId }).filter((enrollment) => {
      if (enrollment.state === "pending" && enrollment.expiresAtMs <= now) {
        // Record the lapse instead of re-offering a stale request on reconnect.
        const expired = transitionLocalSessionEnrollment({
          enrollmentId: enrollment.enrollmentId,
          to: "expired",
          reason: "offer expired",
        });
        if (expired) {
          this.broadcastEnrollment(expired);
        }
        return false;
      }
      return enrollment.state === "pending" || enrollment.state === "active";
    });
    const sources = listRegisteredLocalSessionSources();
    for (const enrollment of enrollments) {
      const source = sources.find(
        (candidate) =>
          candidate.sourceId === enrollment.sourceId && candidate.pluginId === enrollment.pluginId,
      );
      if (!source || !node.commands.includes(source.command)) {
        log.warn(
          `local session bridge: enrollment ${enrollment.enrollmentId} for ${enrollment.sourceId} on ${deviceId.slice(0, 8)} has no usable source (registered=${Boolean(source)}, advertised=${source ? node.commands.includes(source.command) : false})`,
        );
        continue;
      }
      const key = connectionKey(deviceId, enrollment.sourceId);
      // Node connect and enrollment activation reconcile concurrently; a second
      // open for the same channel would start the source twice on the device.
      if (this.connections.has(key) || this.opening.has(key)) {
        continue;
      }
      this.opening.add(key);
      try {
        await this.openConnection({ node, source, enrollment });
      } catch (error) {
        log.warn(
          `local session source ${source.sourceId} on ${deviceId} failed to open: ${String(error)}`,
        );
      } finally {
        this.opening.delete(key);
      }
    }
  }

  private async openConnection(params: {
    node: NodeSession;
    source: LocalSessionSourceDescriptor;
    enrollment: LocalSessionEnrollment;
  }): Promise<void> {
    const { node, source, enrollment } = params;
    const registry = getActivePluginRegistry() ?? undefined;
    const controller = new AbortController();
    const channel = await withPluginRuntimeRegistryScope(registry, () =>
      withPluginRuntimePluginScope({ pluginId: source.pluginId }, () =>
        this.nodes.openDuplex({
          nodeId: node.nodeId,
          command: source.command,
          timeoutMs: 0,
          maxMessageBytes: LOCAL_SESSION_DUPLEX_MAX_MESSAGE_BYTES,
          signal: controller.signal,
        }),
      ),
    );
    const key = connectionKey(node.nodeId, source.sourceId);
    const connection: SourceConnection = {
      key,
      deviceId: node.nodeId,
      source,
      enrollment,
      inputModes: [],
      helloReceived: false,
      threads: new Map(),
      excludedThreadIds: new Set(),
      pendingInputs: new Map(),
      send: (frame) => channel.send(encodeLocalSessionFrame(frame)),
      close: () => {
        controller.abort();
        channel.close();
      },
    };
    this.connections.set(key, connection);
    log.info(`local session bridge: ${source.sourceId} channel open on ${node.nodeId.slice(0, 8)}`);
    channel.onMessage((message) => {
      let frame: LocalSessionSourceFrame;
      try {
        frame = decodeLocalSessionSourceFrame(message);
      } catch (error) {
        log.warn(`local session source ${source.sourceId} sent an invalid frame: ${String(error)}`);
        return undefined;
      }
      return this.handleFrame(connection, frame).catch((error: unknown) => {
        log.warn(`local session frame ${frame.type} failed: ${String(error)}`);
      });
    });
    channel.closed
      .then(
        () => log.info(`local session bridge: ${source.sourceId} channel closed`),
        (error: unknown) =>
          log.warn(`local session bridge: ${source.sourceId} channel failed: ${String(error)}`),
      )
      .finally(() => {
        if (this.connections.get(key) === connection) {
          this.dropConnection(connection, "channel closed");
        }
      });
  }

  private dropConnection(connection: SourceConnection, reason: string): void {
    this.connections.delete(connection.key);
    // Closing aborts the duplex; the channel's abort handlers can throw and this
    // runs inside node lifecycle callbacks, so the failure stays local.
    try {
      connection.close();
    } catch (error) {
      log.debug(`local session channel close for ${connection.key} raised: ${String(error)}`);
    }
    for (const thread of connection.threads.values()) {
      this.threadsBySessionKey.delete(thread.sessionKey);
      this.emitChanged(thread.sessionKey, thread.agentId, "local-session-offline");
    }
    // The device may have applied an input whose result frame was lost with the
    // channel; a rejection would invite a retry that runs it twice. Leave it
    // submitted: the replayed user record (clientId) settles it on reconnect.
    for (const [inputId, scope] of connection.pendingInputs) {
      const receipt = {
        inputId,
        state: "submitted" as const,
        reason: `${reason}; the device did not confirm the message`,
      };
      settleLocalSessionInput(scope, receipt);
      this.publishReceipt(scope.sessionKey, scope.agentId, receipt);
    }
  }

  private async handleFrame(
    connection: SourceConnection,
    frame: LocalSessionSourceFrame,
  ): Promise<void> {
    switch (frame.type) {
      case "hello": {
        if (frame.sourceId !== connection.source.sourceId) {
          throw new Error(`source id mismatch: expected ${connection.source.sourceId}`);
        }
        connection.helloReceived = true;
        connection.inputModes = frame.inputModes;
        if (connection.enrollment.state === "pending") {
          await connection.send({
            type: "offer",
            enrollment: enrollmentSummary(connection.enrollment),
          });
        } else {
          await this.sendResume(connection);
        }
        return;
      }
      case "consent": {
        if (frame.enrollmentId !== connection.enrollment.enrollmentId) {
          return;
        }
        const next = transitionLocalSessionEnrollment({
          enrollmentId: frame.enrollmentId,
          to: frame.decision === "accepted" ? "active" : "declined",
          ...(frame.decision === "declined" ? { reason: "declined on the device" } : {}),
        });
        if (!next) {
          return;
        }
        connection.enrollment = next;
        this.broadcastEnrollment(next);
        if (next.state === "active") {
          await this.sendResume(connection);
        } else {
          // Declined, or accepted after the offer expired: the device must drop
          // its consent so a later request gets a fresh decision.
          void connection.send({ type: "revoke" }).catch(() => {});
          this.dropConnection(connection, `enrollment ${next.state}`);
        }
        return;
      }
      case "session":
        await this.handleSessionFrame(connection, frame);
        return;
      case "records": {
        const thread = connection.threads.get(frame.threadId);
        if (!thread) {
          return;
        }
        thread.appendChain = thread.appendChain.then(() =>
          this.appendRecords(connection, thread, frame.records),
        );
        await thread.appendChain;
      }
      case "delta":
        // Token deltas are not projected in v1: the row's `active` state carries
        // liveness and completed items land through `records` moments later.
        return;
      case "turn": {
        const thread = connection.threads.get(frame.threadId);
        if (!thread) {
          return;
        }
        thread.state = frame.state === "started" ? "active" : "idle";
        this.emitChanged(thread.sessionKey, thread.agentId, "local-session-turn");
        return;
      }
      case "inputResult": {
        const scope = connection.pendingInputs.get(frame.inputId);
        if (!scope) {
          return;
        }
        connection.pendingInputs.delete(frame.inputId);
        settleLocalSessionInput(scope, {
          inputId: frame.inputId,
          state: frame.outcome,
          ...(frame.nativeRef ? { nativeRef: frame.nativeRef } : {}),
          ...(frame.reason ? { reason: frame.reason } : {}),
        });
        this.publishReceipt(scope.sessionKey, scope.agentId, {
          inputId: frame.inputId,
          state: frame.outcome,
          ...(frame.reason ? { reason: frame.reason } : {}),
        });
      }
    }
  }

  private async sendResume(connection: SourceConnection): Promise<void> {
    // Cursors come from the durable checkpoints for this device, not from this
    // (still empty) connection: a reconnect must replay exactly what the
    // Gateway has not committed, or a backlog beyond the bootstrap window is
    // skipped for good when appendRecords advances past it.
    const { agentId, ownerProfileId } = connection.enrollment;
    const cursors: Record<string, number> = {};
    for (const checkpoint of listLocalSessionMirrorCheckpoints(
      { agentId, sessionKey: `agent:${agentId}:main` },
      { deviceId: connection.deviceId },
    )) {
      // Rows are owner-scoped; a checkpoint left by another owner's row for the
      // same thread must not suppress the replay into this owner's row.
      const sessionKey = buildLocalSessionKey({
        agentId,
        sourceId: connection.source.sourceId,
        deviceId: connection.deviceId,
        ownerProfileId,
        threadId: checkpoint.threadId,
      });
      if (loadSessionEntry(sessionKey, { agentId }).entry?.sessionId === checkpoint.sessionId) {
        cursors[checkpoint.threadId] = checkpoint.acceptedSeq;
      }
    }
    for (const [threadId, thread] of connection.threads) {
      cursors[threadId] = Math.max(cursors[threadId] ?? 0, thread.acceptedSeq);
    }
    const excludedThreadIds = listLocalSessionExclusions({
      deviceId: connection.deviceId,
      sourceId: connection.source.sourceId,
    });
    connection.excludedThreadIds = new Set(excludedThreadIds);
    await connection.send({
      type: "resume",
      enrollment: enrollmentSummary(connection.enrollment),
      cursors,
      excludedThreadIds,
    });
  }

  private async handleSessionFrame(
    connection: SourceConnection,
    frame: LocalSessionSourceSessionFrame,
  ): Promise<void> {
    const existing = connection.threads.get(frame.threadId);
    if (frame.state === "closed") {
      if (existing) {
        connection.threads.delete(frame.threadId);
        this.threadsBySessionKey.delete(existing.sessionKey);
        this.emitChanged(existing.sessionKey, existing.agentId, "local-session-closed");
      }
      return;
    }
    if (!existing && connection.excludedThreadIds.has(frame.threadId)) {
      return;
    }
    const thread = existing ?? (await this.ensureThread(connection, frame));
    if (!thread) {
      return;
    }
    thread.state = frame.state;
    thread.canInput = frame.canInput;
    thread.reason = frame.reason;
    if (frame.earliestSeq !== undefined) {
      thread.earliestSeq = frame.earliestSeq;
    }
    if (frame.title || frame.cwd) {
      await patchSessionEntryWithKey(
        { agentId: thread.agentId, sessionKey: thread.sessionKey, storePath: thread.storePath },
        (entry) => ({
          ...(frame.title && entry.label !== frame.title ? { label: frame.title } : {}),
          ...(frame.cwd ? { spawnedCwd: frame.cwd } : {}),
          updatedAt: frame.updatedAt ?? Date.now(),
        }),
      );
    }
    this.emitChanged(thread.sessionKey, thread.agentId, "local-session-status");
  }

  private async ensureThread(
    connection: SourceConnection,
    frame: LocalSessionSourceSessionFrame,
  ): Promise<LiveThread | undefined> {
    const thread = await ensureLocalSessionThread({
      cfg: this.deps.getRuntimeConfig(),
      enrollment: connection.enrollment,
      source: connection.source,
      deviceId: connection.deviceId,
      frame,
    });
    if (thread) {
      connection.threads.set(frame.threadId, thread);
      this.threadsBySessionKey.set(thread.sessionKey, { connection, thread });
    }
    return thread;
  }

  private async appendRecords(
    connection: SourceConnection,
    thread: LiveThread,
    records: LocalSessionRecord[],
  ): Promise<void> {
    const lastSeq = await appendMirroredRecords({
      cfg: this.deps.getRuntimeConfig(),
      thread,
      source: {
        pluginId: connection.source.pluginId,
        sourceId: connection.source.sourceId,
        deviceId: connection.deviceId,
        threadId: thread.threadId,
        enrollmentId: connection.enrollment.enrollmentId,
      },
      records,
    });
    if (lastSeq === undefined) {
      return;
    }
    await connection.send({ type: "ack", threadId: thread.threadId, seq: lastSeq }).catch(() => {});
    this.emitChanged(thread.sessionKey, thread.agentId, "local-session-records");
  }

  private emitChanged(sessionKey: string, agentId: string, reason: string): void {
    const context = this.deps.resolveGatewayContext();
    if (!context) {
      return;
    }
    emitSessionsChanged(context, { sessionKey, agentId, reason });
  }

  private publishReceipt(
    sessionKey: string,
    agentId: string,
    receipt: LocalSessionInputReceipt,
  ): void {
    const context = this.deps.resolveGatewayContext();
    context?.broadcast?.("session.localInput", { sessionKey, agentId, ...receipt });
    this.emitChanged(sessionKey, agentId, "local-session-input");
  }

  private broadcastEnrollment(enrollment: LocalSessionEnrollment): void {
    const context = this.deps.resolveGatewayContext();
    context?.broadcast?.("sessions.local.enrollment", { enrollment });
  }
}
