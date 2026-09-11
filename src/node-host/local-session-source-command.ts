// Node-side runtime for a live local session source. A plugin supplies the
// harness-specific adapter (Codex daemon client, Claude transcript tailer);
// this owns the duplex framing, consent handshake, and input plumbing so every
// source speaks one protocol to the Gateway bridge.
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandIo,
} from "../plugins/types.node-host.js";
import {
  decodeLocalSessionGatewayFrame,
  type LocalSessionGatewayFrame,
  encodeLocalSessionFrame,
  LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS,
  LOCAL_SESSION_SOURCE_PROTOCOL_VERSION,
  type LocalSessionEnrollmentSummary,
  type LocalSessionGatewayInputFrame,
  type LocalSessionInputMode,
  type LocalSessionRecord,
  type LocalSessionSourceFrame,
  type LocalSessionSourceInputResultFrame,
  type LocalSessionSourceSessionFrame,
} from "../sessions/local-session-source-protocol.js";
import { loadNodeHostConfigReadOnly } from "./config.js";
import {
  markLocalSessionConsentDelivered,
  readLocalSessionConsentState,
  recordLocalSessionOffer,
  forgetLocalSessionConsent,
} from "./local-session-consent-store.js";

/** Consent is written by a separate CLI process; poll only while an offer is pending. */
const CONSENT_POLL_INTERVAL_MS = 2000;

export type LocalSessionSourceHost = {
  readonly signal: AbortSignal;
  publishSession(session: Omit<LocalSessionSourceSessionFrame, "type">): Promise<void>;
  publishRecords(threadId: string, records: LocalSessionRecord[]): Promise<void>;
  publishDelta(delta: {
    threadId: string;
    turnId: string;
    itemId: string;
    text: string;
  }): Promise<void>;
  publishTurn(turn: {
    threadId: string;
    turnId: string;
    state: "started" | "completed" | "failed" | "interrupted";
  }): Promise<void>;
  reportInput(result: Omit<LocalSessionSourceInputResultFrame, "type">): Promise<void>;
};

export type LocalSessionSourceStartOptions = {
  enrollment: LocalSessionEnrollmentSummary;
  /** Last committed seq per thread; replay everything after it. Missing thread = bootstrap. */
  cursors: Readonly<Record<string, number>>;
  excludedThreadIds: ReadonlySet<string>;
  signal: AbortSignal;
};

export type LocalSessionSourceSession = {
  /** Outcome is reported asynchronously through `host.reportInput`. */
  submitInput(input: LocalSessionGatewayInputFrame): Promise<void>;
  unshare(threadId: string): void;
  stop(): Promise<void>;
};

export type LocalSessionSourceDefinition = {
  /** Catalog id the Gateway enrollment names, e.g. "codex". */
  id: string;
  command: string;
  /** Human label for the source ("Codex", "Claude Code"); defaults to the id. */
  label?: string;
  hostLabel?: string;
  inputModes: LocalSessionInputMode[];
  prepare?: OpenClawPluginNodeHostCommand["prepare"];
  /**
   * One-time machine-side enablement when the person pre-consented with
   * `openclaw connect --share <id>` (e.g. installing harness hooks). Returns
   * operator-facing notes; failures are reported, never fatal.
   */
  enableSharing?: (context: { env: NodeJS.ProcessEnv }) => Promise<string[]>;
  isAvailable?: (context: OpenClawPluginNodeHostCommandAvailabilityContext) => boolean;
  watchAvailability?: OpenClawPluginNodeHostCommand["watchAvailability"];
  start(
    host: LocalSessionSourceHost,
    options: LocalSessionSourceStartOptions,
  ): Promise<LocalSessionSourceSession>;
};

function chunkRecords(records: LocalSessionRecord[]): LocalSessionRecord[][] {
  const chunks: LocalSessionRecord[][] = [];
  for (let index = 0; index < records.length; index += LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS) {
    chunks.push(records.slice(index, index + LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS));
  }
  return chunks;
}

/** Wrap a source definition as the duplex node command the Gateway bridge opens. */
// Per-source stop in flight across duplex reconnects in this process.
const sourceStops = new Map<string, Promise<void>>();

export function createLocalSessionSourceNodeCommand(
  definition: LocalSessionSourceDefinition,
): OpenClawPluginNodeHostCommand {
  let activeStop: (() => Promise<void>) | undefined;
  return {
    command: definition.command,
    duplex: true,
    localSessionSource: { sourceId: definition.id, label: definition.label ?? definition.id },
    ...(definition.prepare ? { prepare: definition.prepare } : {}),
    ...(definition.isAvailable ? { isAvailable: definition.isAvailable } : {}),
    ...(definition.watchAvailability ? { watchAvailability: definition.watchAvailability } : {}),
    onDisconnect: async () => {
      await activeStop?.();
    },
    handle: async (_paramsJSON, io) => {
      if (!io?.frames) {
        throw new Error(`Local session source ${definition.id} requires duplex frames.`);
      }
      const run = await runLocalSessionSourceChannel(definition, io);
      activeStop = run.stop;
      try {
        await run.closed;
      } finally {
        activeStop = undefined;
      }
      return JSON.stringify({ ok: true, sourceId: definition.id });
    },
  };
}

async function runLocalSessionSourceChannel(
  definition: LocalSessionSourceDefinition,
  io: OpenClawPluginNodeHostCommandIo,
): Promise<{ closed: Promise<void>; stop: () => Promise<void> }> {
  const frames = io.frames;
  if (!frames) {
    throw new Error("duplex frames required");
  }
  // One ordered send queue: records must reach the Gateway in seq order.
  let sendChain: Promise<void> = Promise.resolve();
  const send = (frame: LocalSessionSourceFrame): Promise<void> => {
    sendChain = sendChain.then(async () => {
      if (io.signal.aborted) {
        return;
      }
      await frames.send(encodeLocalSessionFrame(frame));
    });
    return sendChain;
  };

  let session: LocalSessionSourceSession | undefined;
  let sessionAbort: AbortController | undefined;
  let enrollment: LocalSessionEnrollmentSummary | undefined;
  let consentTimer: NodeJS.Timeout | undefined;

  const stopSession = async () => {
    if (!session) {
      return;
    }
    const stopping = stopCurrentSession();
    sourceStops.set(
      definition.id,
      stopping.catch(() => {}),
    );
    await stopping;
  };
  const stopCurrentSession = async () => {
    const current = session;
    session = undefined;
    sessionAbort?.abort();
    sessionAbort = undefined;
    await current?.stop();
  };

  const host = (signal: AbortSignal): LocalSessionSourceHost => ({
    signal,
    publishSession: (frame) => send({ type: "session", ...frame }),
    publishRecords: async (threadId, records) => {
      for (const chunk of chunkRecords(records)) {
        await send({ type: "records", threadId, records: chunk });
      }
    },
    publishDelta: (delta) => send({ type: "delta", ...delta }),
    publishTurn: (turn) => send({ type: "turn", ...turn }),
    reportInput: (result) => send({ type: "inputResult", ...result }),
  });

  // The hello chain and the poll timer both call this; one pass at a time so a
  // decision is delivered exactly once before it is marked delivered.
  let deliveringConsents = false;
  const deliverPendingConsents = async () => {
    if (deliveringConsents) {
      return;
    }
    deliveringConsents = true;
    try {
      const state = readLocalSessionConsentState();
      for (const consent of state.consents) {
        if (consent.sourceId !== definition.id || consent.deliveredAtMs !== undefined) {
          continue;
        }
        await send({
          type: "consent",
          enrollmentId: consent.enrollment.enrollmentId,
          decision: consent.decision,
        });
        markLocalSessionConsentDelivered(consent.enrollment.enrollmentId);
      }
      const stillPending = state.offers.some((offer) => offer.sourceId === definition.id);
      if (!stillPending && consentTimer) {
        clearInterval(consentTimer);
        consentTimer = undefined;
      }
    } finally {
      deliveringConsents = false;
    }
  };

  const ensureConsentWatcher = () => {
    if (consentTimer) {
      return;
    }
    consentTimer = setInterval(() => {
      void deliverPendingConsents().catch(() => {});
    }, CONSENT_POLL_INTERVAL_MS);
  };

  const startSession = async (options: {
    enrollment: LocalSessionEnrollmentSummary;
    cursors: Record<string, number>;
    excludedThreadIds: string[];
  }) => {
    // The Gateway may reopen this duplex before the previous channel's session
    // finished stopping (its socket server, watchers); a source binds one
    // listener per machine, so the new session waits for that stop first.
    const previousStop = sourceStops.get(definition.id);
    await stopSession();
    await previousStop;
    enrollment = options.enrollment;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    io.signal.addEventListener("abort", onAbort, { once: true });
    sessionAbort = abort;
    session = await definition.start(host(abort.signal), {
      enrollment: options.enrollment,
      cursors: options.cursors,
      excludedThreadIds: new Set(options.excludedThreadIds),
      signal: abort.signal,
    });
  };

  const handleFrame = async (message: Uint8Array) => {
    let frame: LocalSessionGatewayFrame;
    try {
      frame = decodeLocalSessionGatewayFrame(message);
    } catch (error) {
      // One bad frame must not take every shared session offline; the Gateway
      // learns nothing was applied from the missing inputResult/session frames.
      console.error(
        `local session source ${definition.id} dropped an invalid frame: ${String(error)}`,
      );
      return;
    }
    switch (frame.type) {
      case "offer": {
        const paired = (await loadNodeHostConfigReadOnly())?.gateway;
        const recorded = recordLocalSessionOffer({
          sourceId: definition.id,
          enrollment: frame.enrollment,
          ...(paired?.host && paired.port
            ? {
                gateway: {
                  host: paired.host,
                  port: paired.port,
                  contextPath: paired.contextPath ?? "",
                },
              }
            : {}),
        });
        if (recorded.autoAccepted) {
          console.error(
            `local session source ${definition.id}: sharing with ${frame.enrollment.requester.displayName}'s team accepted from your connect command`,
          );
          if (definition.enableSharing) {
            try {
              for (const note of await definition.enableSharing({ env: process.env })) {
                console.error(`local session source ${definition.id}: ${note}`);
              }
            } catch (error) {
              console.error(
                `local session source ${definition.id}: enablement failed: ${String(error)}`,
              );
            }
          }
        }
        ensureConsentWatcher();
        return;
      }
      case "resume": {
        // The Gateway side can open this duplex on its own; only a consent the
        // person recorded here (openclaw sessions share --accept) may publish.
        const consent = readLocalSessionConsentState().consents.find(
          (candidate) =>
            candidate.sourceId === definition.id &&
            candidate.decision === "accepted" &&
            candidate.enrollment.enrollmentId === frame.enrollment.enrollmentId &&
            candidate.enrollment.agentId === frame.enrollment.agentId &&
            candidate.enrollment.requester.profileId === frame.enrollment.requester.profileId,
        );
        if (!consent) {
          console.error(
            `local session source ${definition.id}: refusing resume for enrollment ${frame.enrollment.enrollmentId} without a local accepted consent`,
          );
          return;
        }
        await startSession(frame);
      }
      case "ack":
        return;
      case "input":
        if (!session) {
          await send({
            type: "inputResult",
            inputId: frame.inputId,
            threadId: frame.threadId,
            outcome: "rejected",
            reason: "source is not attached to a shared session",
          });
          return;
        }
        await session.submitInput(frame);
        return;
      case "unshare":
        session?.unshare(frame.threadId);
        return;
      case "revoke":
        if (enrollment) {
          forgetLocalSessionConsent(enrollment.enrollmentId);
        }
        await stopSession();
    }
  };

  const closed = new Promise<void>((resolve, reject) => {
    const finish = async (failure?: Error) => {
      if (failure) {
        console.error(`local session source ${definition.id} failed: ${failure.message}`);
      }
      if (consentTimer) {
        clearInterval(consentTimer);
        consentTimer = undefined;
      }
      try {
        await stopSession();
      } finally {
        if (failure) {
          reject(failure);
        } else {
          resolve();
        }
      }
    };
    const fail = (error: unknown) => {
      void finish(error instanceof Error ? error : new Error(String(error)));
    };
    io.signal.addEventListener("abort", () => void finish(), { once: true });
    // Registering the listener announces readiness to the Gateway; hello follows it.
    // Returning the promise keeps frame handling ordered and lets the framing
    // layer apply backpressure instead of racing ahead of an unfinished frame.
    frames.onMessage((message) => handleFrame(message).catch(fail));
    void send({
      type: "hello",
      protocol: LOCAL_SESSION_SOURCE_PROTOCOL_VERSION,
      sourceId: definition.id,
      ...(definition.hostLabel ? { hostLabel: definition.hostLabel } : {}),
      inputModes: definition.inputModes,
    })
      .then(() => deliverPendingConsents())
      .catch(fail);
  });

  return { closed, stop: stopSession };
}
