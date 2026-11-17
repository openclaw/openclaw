// Browser-owned SAS approver. Private ephemeral state never leaves this origin or enters Solid.
import {
  bytesToHex,
  MEMBER_BROWSER_REQUEST_TTL_SECONDS,
  fingerprint,
  formatEd25519PublicKey,
  generateEphemeralKey,
  hexToBytes,
  isEd25519PublicKey,
  isIrohEndpointKey,
  isNodeDescription,
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
  type NodeDescription,
  type ReceiveMailResponse,
  type SasStart,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createDeviceMail, readOwnerApprovalContext, type DeviceMail } from "./device-mail.ts";
import type { OpenClawIdRecoveryUse } from "./types.ts";

type Attempt = {
  start: SasStart;
  commitment: string;
  sender: string;
  member?: { name: string; email: string | null; location: string | null };
  expires: number;
  receivedAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
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
  member?: { name: string; email: string | null; location: string | null };
  /**
   * What the new device's node may use, when it also asked to run tools for the claw. Its node
   * key and this surface are in the SAS commitment, so the compared code covers them.
   */
  tools?: { commands: string[]; caps: string[] };
  code?: string;
  busy: boolean;
  error?: string;
  expired?: boolean;
  uncertain?: boolean;
};
/** Browser lifetime state for owner approval. */
export type OwnerApprovalState = {
  requests: OwnerApprovalRequest[];
  error: string | null;
  ready: boolean;
  /** The claw's hostname, once known; approval dialogs name the claw. */
  hostname?: string;
};

const now = () => Math.floor(Date.now() / 1000);

/**
 * An app's node from a `start`: its key and the surface it asks for, both bound by the
 * commitment. Undefined when absent (a browser); null when malformed, so the start is ignored.
 */
function appNode(
  value: unknown,
  devicePeerKey: string,
): { peer_key: string; description: NodeDescription } | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // SAFETY: the guard above rejected non-objects, null and arrays.
  const { peer_key, description, ...rest } = value as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    !isIrohEndpointKey(peer_key) ||
    peer_key === devicePeerKey ||
    !isNodeDescription(description)
  ) {
    return null;
  }
  return { peer_key, description };
}
const expiredRequest = "This device request expired or was cancelled.";

/** Owns one cancellable mailbox reader and bounded SAS attempts for this original browser D. */
export function createOwnerApproval(
  client: GatewayBrowserClient,
  onRequest: (request: OwnerApprovalRequest) => void,
  onKitUsed: (device: string | undefined) => void = () => {},
  onMemberDeviceAdded: (recoveryUse: OpenClawIdRecoveryUse | undefined) => void = () => {},
) {
  const abort = new AbortController();
  const attempts = new Map<string, Attempt>();
  const expiredRequests = new Map<string, OwnerApprovalRequest>();
  const listeners = new Set<() => void>();
  let mail: DeviceMail | undefined;
  let error: string | null = null;
  let cursor = "0";
  let hostname: string | undefined;
  let started = false;
  let ownsLock = false;
  const lifetime = Promise.withResolvers<void>();
  const publish = () => listeners.forEach((listener) => listener());
  const projectRequest = (id: string, a: Attempt): OwnerApprovalRequest => ({
    id,
    label: a.start.label,
    member: a.member,
    ...(a.start.node
      ? {
          tools: {
            commands: [...a.start.node.description.commands],
            caps: [...a.start.node.description.caps],
          },
        }
      : {}),
    code: a.code,
    busy: a.busy,
    error: a.error ?? (a.expires <= now() ? expiredRequest : undefined),
    expired: a.expires <= now(),
    uncertain: Boolean(a.submissionStarted && a.error),
  });
  const drop = (id: string, force = false) => {
    const attempt = attempts.get(id);
    if (attempt?.busy && !force) {
      attempt.cancelled = true;
      publish();
      return;
    }
    clearTimeout(attempt?.expiryTimer);
    attempt?.secret?.fill(0);
    attempts.delete(id);
    publish();
  };
  const expire = (id: string) => {
    const attempt = attempts.get(id);
    if (!attempt) {
      return;
    }
    clearTimeout(attempt.expiryTimer);
    const remaining = attempt.expires * 1000 - Date.now();
    if (remaining > 0) {
      attempt.expiryTimer = setTimeout(() => expire(id), remaining);
      return;
    }
    // Keep only display facts after expiry; pending/uncertain admissions still own their result.
    if (!attempt.busy) {
      expiredRequests.set(id, projectRequest(id, attempt));
    }
    drop(id);
  };
  const send = async (
    attempt: Attempt,
    step: "accept" | "sealed" | "abort",
    data: Record<string, unknown>,
  ) => {
    abort.signal.throwIfAborted();
    await mail!.call("send", {
      to: attempt.sender,
      payload: {
        kind: "enrollment",
        request_id: attempt.start.request_id,
        step,
        data: {
          ...data,
          ...(attempt.start.member_account_id
            ? { member_account_id: attempt.start.member_account_id }
            : {}),
        },
      },
    });
  };

  // A start is only a request, not authority. Bind its reported sender to the committed D.
  const startAttempt = async (
    message: MailboxMessage,
    payload: Extract<MailboxPayload, { kind: "enrollment" }>,
  ) => {
    const d = payload.data;
    if (
      attempts.has(payload.request_id) ||
      !isRandomId(payload.request_id) ||
      message.received_at <
        now() - (d.member_account_id ? MEMBER_BROWSER_REQUEST_TTL_SECONDS : 300) ||
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
    const expires = d.member_account_id ? d.expires_at : message.received_at + 300;
    if (
      typeof expires !== "number" ||
      !Number.isSafeInteger(expires) ||
      expires <= now() ||
      expires >
        message.received_at + (d.member_account_id ? MEMBER_BROWSER_REQUEST_TTL_SECONDS : 300)
    ) {
      return;
    }
    const node = appNode(d.node, d.peer_key);
    if (node === null) {
      return;
    }
    const sender = await fingerprint(d.device_pub);
    if (message.from.device_fp !== sender) {
      return;
    }
    let member: Attempt["member"];
    if (d.member_account_id !== undefined) {
      if (typeof d.member_account_id !== "string" || !d.member_account_id || node) {
        return;
      }
      const ctx = await readOwnerApprovalContext(client);
      const current = ctx.link.members?.find((m) => m.accountId === d.member_account_id);
      if (!current || !mail!.own.body.caps.includes("manage_members")) {
        return;
      }
      member = {
        name: current.displayName || current.email || "Member",
        email: current.email,
        location:
          typeof message.location_hint === "string" ? message.location_hint.slice(0, 256) : null,
      };
    }
    const attempt: Attempt = {
      member,
      start: {
        request_id: payload.request_id,
        claw_id: mail!.clawId,
        device_pub: d.device_pub,
        peer_key: d.peer_key,
        label: d.label,
        ...(node ? { node } : {}),
        ...(typeof d.member_account_id === "string"
          ? { member_account_id: d.member_account_id }
          : {}),
      },
      commitment: d.commit,
      sender,
      expires,
      receivedAt: message.received_at,
      ephemeral: await generateEphemeralKey(),
      busy: false,
    };
    abort.signal.throwIfAborted();
    const replaces = (previous: Attempt) =>
      previous.sender === sender ||
      (typeof d.member_account_id === "string" &&
        previous.start.member_account_id === d.member_account_id);
    const previous = [...attempts].filter(([, a]) => replaces(a));
    // Admission owns its outcome; a delayed older start cannot replace the latest request.
    if (
      previous.some(([, a]) => a.busy || a.submissionStarted || a.receivedAt > message.received_at)
    ) {
      return;
    }
    if (attempts.size - previous.length >= 16) {
      return;
    }
    for (const [id] of previous) {
      drop(id);
    }
    // A fresh request replaces the prior expired display, keeping retained facts bounded.
    expiredRequests.clear();
    attempts.set(payload.request_id, attempt);
    expire(payload.request_id);
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
    onRequest(projectRequest(payload.request_id, attempt));
  };

  // Reveal must match N's commitment before computing the matching number.
  const receive = async (message: MailboxMessage) => {
    const p = message.payload;
    if (p.kind === "notice" && message.claw_id === mail!.clawId) {
      if (p.event === "kit_used") {
        // A hint only: name the device the Gateway now lists under that fingerprint, if any.
        const ctx = await readOwnerApprovalContext(client);
        onKitUsed(ctx.link.ownerDevices?.find((device) => device.deviceFp === p.ref)?.label);
      } else if (p.event === "member_device_added") {
        // History is append-ordered and survives revocation; current admission owns provenance.
        const ctx = await readOwnerApprovalContext(client);
        abort.signal.throwIfAborted();
        const use = ctx.link.recoveryUses?.findLast((entry) => entry.peerFp === p.ref);
        const device = ctx.link.members
          ?.find((member) => member.accountId === use?.accountId)
          ?.devices?.find((entry) => entry.peerKey === use?.peerKey);
        onMemberDeviceAdded(device?.approvedBy?.kind === "member_recovery_kit" ? use : undefined);
      }
      return;
    }
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
    try {
      attempt.secret = await sasSharedSecret(attempt.ephemeral, ephemeralN);
    } catch {
      // Invalid peer points reject this request, not the shared mailbox reader.
      drop(p.request_id);
      return;
    }
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
          expire(id);
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
    hostname = link.hostname;
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
        hostname,
        requests: [
          ...expiredRequests.values(),
          ...[...attempts].map(([id, a]) => projectRequest(id, a)),
        ],
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
      expiredRequests.clear();
      for (const id of attempts.keys()) {
        drop(id, true);
      }
      listeners.clear();
    },
    /** Deny never submits membership. Approval admits first, then releases the sealed handoff. */
    async decide(
      id: string,
      approve: boolean,
      expiresAt: number | null = null,
      comparedCode?: string,
    ) {
      const a = attempts.get(id);
      if (!a || a.busy) {
        return;
      }
      if (a.expires <= now()) {
        expire(id);
        return;
      }
      const requireLive = () => {
        abort.signal.throwIfAborted();
        if (attempts.get(id) !== a || a.cancelled || a.expires <= now()) {
          throw new Error(expiredRequest);
        }
      };
      a.busy = true;
      a.error = undefined;
      publish();
      try {
        if (!approve) {
          drop(id, true);
          try {
            await send(a, "abort", { reason: "sas_mismatch" });
          } finally {
            if (a.start.member_account_id) {
              await mail!
                .call("send", {
                  to: "gateway",
                  payload: {
                    kind: "member_browser_request",
                    action: "cancel",
                    request_id: id,
                    member_account_id: a.start.member_account_id,
                    label: a.start.label,
                    expires_at: a.expires,
                  },
                })
                .catch(() => {
                  console.warn(
                    "The denied browser's Inbox notice could not be retired; it will expire.",
                  );
                });
            }
          }
          return;
        }
        if (!a.code || !a.secret || !a.transcript) {
          throw new Error("Wait for the matching number on both screens.");
        }
        if (a.member && comparedCode !== a.code) {
          throw new Error("Enter the six-digit code the member reads to you.");
        }
        const ctx = await readOwnerApprovalContext(client);
        if (
          a.start.member_account_id &&
          !ctx.link.members?.some((m) => m.accountId === a.start.member_account_id)
        ) {
          throw new Error("This browser request is no longer available.");
        }
        const own = ctx.link.ownerDevices?.find(
          (d) => d.devicePub === formatEd25519PublicKey(mail!.signer.publicKey),
        );
        if (
          !own ||
          !own.cert.body.caps.includes(a.member ? "manage_members" : "approve_device") ||
          ctx.link.clawId !== mail!.clawId ||
          !ctx.binding
        ) {
          throw new Error("This browser is no longer an active owner device.");
        }
        const cert = a.member
          ? null
          : await signStatement(
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
            target: a.start.member_account_id
              ? {
                  op: "add_member_device",
                  account_id: a.start.member_account_id,
                  // SAFETY: startAttempt validates the two key formats.
                  peer_key: a.start.peer_key as `iroh:${string}`,
                  // SAFETY: startAttempt validates the two key formats.
                  device_pub: a.start.device_pub as `ed25519:${string}`,
                  label: a.start.label,
                }
              : {
                  op: "add_owner_device",
                  cert: cert!,
                  ...(a.start.node
                    ? {
                        node: {
                          // SAFETY: checked by isIrohEndpointKey when the start message was accepted.
                          peer_key: a.start.node.peer_key as `iroh:${string}`,
                          label: a.start.label,
                          description: a.start.node.description,
                        },
                      }
                    : {}),
                },
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
        const handoff: JsonValue = {
          root_pub: ctx.link.rootPub,
          binding: ctx.binding,
          cert,
        };
        const sealed = await sealHandoff(a.secret, a.transcript, handoff);
        requireLive();
        await send(a, "sealed", sealed);
        drop(id, true);
      } catch (failure) {
        const detail = failure instanceof Error ? failure.message : String(failure);
        // Do not add an automatic retry of an external write or admit the same N twice.
        a.error = a.submissionStarted
          ? a.member
            ? `${detail} Check the member’s devices in Access: if this browser was admitted, remove it before starting a new request.`
            : `${detail} Check Your devices: if this browser was admitted, revoke it before starting a new request.`
          : detail;
        a.busy = Boolean(a.submissionStarted);
        publish();
      }
    },
  };
}

export type OwnerApproval = ReturnType<typeof createOwnerApproval>;
