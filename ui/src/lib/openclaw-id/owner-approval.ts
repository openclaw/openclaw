// Browser-owned SAS approver. Private ephemeral state never leaves this origin or enters Solid.
import {
  bytesToHex,
  fingerprint,
  formatEd25519PublicKey,
  generateEphemeralKey,
  hexToBytes,
  isEd25519PublicKey,
  isIrohEndpointKey,
  isRandomId,
  ownerDeviceCertBody,
  sasCode,
  sasSharedSecret,
  sasTranscript,
  sealHandoff,
  signStatement,
  verifySasCommitment,
  type EphemeralKey,
  type JsonValue,
  type MailboxMessage,
  type MailboxPayload,
  type ReceiveMailResponse,
  type SasStart,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createDeviceMail, readOwnerApprovalContext, type DeviceMail } from "./device-mail.ts";

type Attempt = {
  start: SasStart;
  commitment: string;
  sender: string;
  expires: number;
  ephemeral: EphemeralKey;
  secret?: Uint8Array;
  transcript?: Uint8Array;
  code?: string;
  busy: boolean;
  error?: string;
  submissionStarted?: boolean;
  cancelled?: boolean;
};
/** Public request projection: no keys, credentials, or handoff material. */
export type OwnerApprovalRequest = {
  id: string;
  label: string;
  code?: string;
  busy: boolean;
  error?: string;
};
/** Browser lifetime state for owner approval. */
export type OwnerApprovalState = {
  requests: OwnerApprovalRequest[];
  error: string | null;
  ready: boolean;
};

const now = () => Math.floor(Date.now() / 1000);

/** Owns one cancellable mailbox reader and bounded SAS attempts for this original browser D. */
export function createOwnerApproval(client: GatewayBrowserClient, onRequest: () => void) {
  const abort = new AbortController();
  const attempts = new Map<string, Attempt>();
  const listeners = new Set<() => void>();
  let mail: DeviceMail | undefined;
  let error: string | null = null;
  let cursor = "0";
  let started = false;
  let ownsLock = false;
  const lifetime = Promise.withResolvers<void>();
  const publish = () => listeners.forEach((listener) => listener());
  const drop = (id: string, force = false) => {
    const attempt = attempts.get(id);
    if (attempt?.busy && !force) {
      attempt.cancelled = true;
      return;
    }
    attempt?.secret?.fill(0);
    attempts.delete(id);
    publish();
  };
  const send = async (
    attempt: Attempt,
    step: "accept" | "sealed" | "abort",
    data: Record<string, unknown>,
  ) => {
    abort.signal.throwIfAborted();
    await mail!.call("send", {
      to: attempt.sender,
      payload: { kind: "enrollment", request_id: attempt.start.request_id, step, data },
    });
  };

  // A start is only a request, not authority. Bind its reported sender to the committed D.
  const startAttempt = async (
    message: MailboxMessage,
    payload: Extract<MailboxPayload, { kind: "enrollment" }>,
  ) => {
    const d = payload.data;
    if (
      attempts.size >= 16 ||
      attempts.has(payload.request_id) ||
      !isRandomId(payload.request_id) ||
      message.received_at < now() - 300 ||
      message.received_at > now() + 30 ||
      d.claw_id !== mail!.clawId ||
      !isEd25519PublicKey(d.device_pub) ||
      !isIrohEndpointKey(d.peer_key) ||
      typeof d.label !== "string" ||
      d.label.length < 1 ||
      d.label.length > 64 ||
      typeof d.commit !== "string" ||
      !/^[a-f0-9]{64}$/.test(d.commit)
    ) {
      return;
    }
    const sender = await fingerprint(d.device_pub);
    if (message.from.device_fp !== sender) {
      return;
    }
    const attempt: Attempt = {
      start: {
        request_id: payload.request_id,
        claw_id: mail!.clawId,
        device_pub: d.device_pub,
        peer_key: d.peer_key,
        label: d.label,
      },
      commitment: d.commit,
      sender,
      expires: message.received_at + 300,
      ephemeral: await generateEphemeralKey(),
      busy: false,
    };
    abort.signal.throwIfAborted();
    // Do not evict an in-flight or uncertain admission with a new start from the same D.
    if ([...attempts.values()].some((previous) => previous.sender === sender && previous.busy)) {
      return;
    }
    // Keep one newest request for a device, so repeated starts do not duplicate approval actions.
    for (const [id, previous] of attempts) {
      if (previous.sender === sender) {
        drop(id);
      }
    }
    attempts.set(payload.request_id, attempt);
    try {
      await send(attempt, "accept", {
        eph_pub: bytesToHex(attempt.ephemeral.publicKey),
        device_pub: formatEd25519PublicKey(mail!.signer.publicKey),
      });
    } catch (failure) {
      drop(payload.request_id);
      throw failure;
    }
    publish();
    onRequest();
  };

  // Reveal must match N's commitment before computing the matching number.
  const receive = async (message: MailboxMessage) => {
    const p = message.payload;
    if (p.kind !== "enrollment" || message.claw_id !== mail!.clawId) {
      return;
    }
    if (p.step === "start") {
      await startAttempt(message, p);
      return;
    }
    const attempt = attempts.get(p.request_id);
    if (!attempt || message.from.device_fp !== attempt.sender) {
      return;
    }
    if (p.step === "abort") {
      drop(p.request_id);
      return;
    }
    if (p.step !== "key" || attempt.code || attempt.expires <= now()) {
      return;
    }
    if (typeof p.data.eph_pub !== "string" || !/^[a-f0-9]{64}$/.test(p.data.eph_pub)) {
      drop(p.request_id);
      return;
    }
    const ephemeralN = hexToBytes(p.data.eph_pub);
    if (!(await verifySasCommitment(attempt.commitment, ephemeralN, attempt.start))) {
      await send(attempt, "abort", { reason: "commitment_mismatch" });
      drop(p.request_id);
      return;
    }
    attempt.secret = await sasSharedSecret(attempt.ephemeral, ephemeralN);
    attempt.transcript = await sasTranscript({
      start: attempt.start,
      commit: attempt.commitment,
      ephemeralPublicE: attempt.ephemeral.publicKey,
      ephemeralPublicN: ephemeralN,
      devicePubE: formatEd25519PublicKey(mail!.signer.publicKey),
    });
    attempt.code = await sasCode(attempt.secret, attempt.transcript);
    abort.signal.throwIfAborted();
    publish();
  };

  // Existing Discovery long-poll protocol; failure stops it, with explicit Retry in the UI.
  const poll = async () => {
    mail = await createDeviceMail(client, abort.signal);
    publish();
    while (!abort.signal.aborted) {
      const received = await mail.call<ReceiveMailResponse>("receive", undefined, cursor);
      for (const [id, a] of attempts) {
        if (a.expires <= now()) {
          drop(id);
        }
      }
      for (const message of received.messages) {
        await receive(message);
      }
      if (received.cursor) {
        cursor = received.cursor;
      }
    }
  };
  const failed = (failure: unknown) => {
    if (!abort.signal.aborted) {
      error = failure instanceof Error ? failure.message : String(failure);
      publish();
    }
  };
  const run = async () => {
    const { link } = await readOwnerApprovalContext(client);
    abort.signal.throwIfAborted();
    if (!navigator.locks || !link.clawId) {
      throw new Error("This browser needs Web Locks to coordinate owner approval across tabs.");
    }
    // Same-origin tabs share D: exactly one may answer with its ephemeral key.
    await navigator.locks.request(
      `openclaw-id-approval:${link.clawId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          throw new Error(
            "Another tab is listening for owner approval. Use that tab, or close it and Retry here.",
          );
        }
        ownsLock = true;
        void poll().catch(failed);
        await lifetime.promise;
      },
    );
  };

  return {
    read(): OwnerApprovalState {
      return {
        ready: Boolean(mail),
        error,
        requests: [...attempts].map(([id, a]) => ({
          id,
          label: a.start.label,
          code: a.code,
          busy: a.busy,
          error: a.error,
        })),
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (!started) {
        started = true;
        void run().catch(failed);
      }
    },
    /** Explicit retry after transport failure, never a repeat membership submission. */
    retry() {
      if (error && !abort.signal.aborted) {
        error = null;
        publish();
        if (ownsLock) {
          void poll().catch(failed);
        } else {
          void run().catch(failed);
        }
      }
    },
    stop() {
      abort.abort();
      lifetime.resolve();
      for (const id of attempts.keys()) {
        drop(id, true);
      }
      listeners.clear();
    },
    /** Deny never submits membership. Approval admits first, then releases the sealed handoff. */
    async decide(id: string, approve: boolean, expiresAt: number | null = null) {
      const a = attempts.get(id);
      if (!a || a.busy) {
        return;
      }
      if (a.expires <= now()) {
        drop(id);
        return;
      }
      const requireLive = () => {
        abort.signal.throwIfAborted();
        if (attempts.get(id) !== a || a.cancelled || a.expires <= now()) {
          throw new Error("This device request expired or was cancelled.");
        }
      };
      a.busy = true;
      a.error = undefined;
      publish();
      try {
        if (!approve) {
          await send(a, "abort", { reason: "sas_mismatch" });
          drop(id, true);
          return;
        }
        if (!a.code || !a.secret || !a.transcript) {
          throw new Error("Wait for the matching number on both screens.");
        }
        const ctx = await readOwnerApprovalContext(client);
        const own = ctx.link.ownerDevices?.find(
          (d) => d.devicePub === formatEd25519PublicKey(mail!.signer.publicKey),
        );
        if (
          !own ||
          !own.cert.body.caps.includes("approve_device") ||
          ctx.link.clawId !== mail!.clawId ||
          !ctx.binding
        ) {
          throw new Error("This browser is no longer an active owner device.");
        }
        const cert = await signStatement(
          "OwnerDeviceCert",
          ownerDeviceCertBody({
            // SAFETY: checked by isEd25519PublicKey when the start message was accepted.
            device_pub: a.start.device_pub as `ed25519:${string}`,
            // SAFETY: checked by isIrohEndpointKey when the start message was accepted.
            peer_keys: [a.start.peer_key as `iroh:${string}`],
            label: a.start.label,
            caps: own.cert.body.caps,
            now: now(),
            expires_at: expiresAt,
          }),
          mail!.signer,
        );
        const statement = await signStatement(
          "MembershipChange",
          {
            claw_id: mail!.clawId,
            seq: ctx.link.seq! + 1,
            target: { op: "add_owner_device", cert },
            issued_at: now(),
          },
          mail!.signer,
        );
        requireLive();
        a.submissionStarted = true;
        await client.request(
          "openclawId.authority",
          { action: "submit", statement },
          { signal: abort.signal, retainSentResultOnAbort: true },
        );
        requireLive();
        const handoff = {
          root_pub: ctx.link.rootPub,
          binding: ctx.binding,
          cert,
        };
        // SAFETY: the handoff holds only JSON values: strings and signed statements.
        const sealed = await sealHandoff(a.secret, a.transcript, handoff as unknown as JsonValue);
        requireLive();
        await send(a, "sealed", sealed);
        drop(id, true);
      } catch (failure) {
        const detail = failure instanceof Error ? failure.message : String(failure);
        // Do not add an automatic retry of an external write or admit the same N twice.
        a.error = a.submissionStarted
          ? `${detail} Check Your devices: if this browser was admitted, revoke it before starting a new request.`
          : detail;
        a.busy = Boolean(a.submissionStarted);
        publish();
      }
    },
  };
}

export type OwnerApproval = ReturnType<typeof createOwnerApproval>;
