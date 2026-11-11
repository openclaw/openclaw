// Gateway side of the Discovery API (mirror + mailbox). Every request is
// signed with K_gw; nothing Discovery returns is trusted for membership.
import {
  DISCOVERY_ENDPOINTS,
  DISCOVERY_SIGNATURE_HEADER,
  signDiscoveryRequest,
  type CheckClawNameResponse,
  type ClawDescriptor,
  type DiscoveryEndpoint,
  type KeyFingerprint,
  type MailboxPayload,
  type ReceiveMailResponse,
  type RegisterClawResponse,
  type GetRegistrationResponse,
  type SendMailResponse,
  type SignedStatement,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";

/** A Discovery error with its stable code (`error.code` in the body). */
export class DiscoveryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** How long one Discovery request, including its response body, may take. */
const REQUEST_DEADLINE_MS = 30_000;

/**
 * Creates a client for one Discovery base URL, signing as K_gw. `signal` belongs to
 * the caller's lifecycle: aborting it cancels every request in flight.
 */
export function createDiscoveryClient(params: {
  baseUrl: string;
  signer: StatementSigner;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;

  // Sends one signed request and parses a JSON (or empty) response.
  const call = async <T>(
    endpoint: DiscoveryEndpoint,
    vars: Record<string, string>,
    body?: unknown,
    query = "",
    signal?: AbortSignal,
    deadlineMs = REQUEST_DEADLINE_MS,
  ): Promise<T> => {
    const spec = DISCOVERY_ENDPOINTS[endpoint];
    const path =
      spec.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(vars[name] ?? "")) +
      query;
    const bytes =
      body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
    const signature = await signDiscoveryRequest(
      { method: spec.method, path, body: bytes, ts: Math.floor(Date.now() / 1000) },
      params.signer,
    );
    const response = await fetchImpl(new URL(path, params.baseUrl), {
      method: spec.method,
      headers: {
        [DISCOVERY_SIGNATURE_HEADER]: signature,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: bytes }),
      // The fetch signal also bounds reading the body below.
      signal: AbortSignal.any([
        AbortSignal.timeout(deadlineMs),
        ...(params.signal ? [params.signal] : []),
        ...(signal ? [signal] : []),
      ]),
    });
    const text = await response.text();
    if (!response.ok) {
      let code = "unavailable";
      let message = `Discovery ${endpoint} failed with HTTP ${response.status}`;
      try {
        // SAFETY: every field is optional and read with ?? fallbacks; a non-object body throws into the catch.
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // Non-JSON error bodies keep the generic message.
      }
      throw new DiscoveryRequestError(response.status, code, message);
    }
    // SAFETY: T is the response shape Discovery's API documents for this endpoint; callers read it defensively.
    return (text ? JSON.parse(text) : undefined) as T;
  };

  return {
    /** The hostname the code's account gets for a claw name, and whether it is free (code not spent). */
    checkClawName: (code: string, name: string) =>
      call<CheckClawNameResponse>("checkClawName", {}, { code, name }),
    /** Registers the claw with a one-time enrollment code from the signed-in owner. */
    registerClaw: (code: string, descriptor: ClawDescriptor) =>
      call<RegisterClawResponse>("registerClaw", {}, { code, descriptor }),
    /** Reads only this Gateway's registration, authenticated by the currently registered K_gw. */
    getRegistration: (clawId: string) =>
      call<GetRegistrationResponse>("getRegistration", { claw_id: clawId }),
    publishDescriptor: (descriptor: ClawDescriptor) =>
      call<void>("publishDescriptor", { claw_id: descriptor.claw_id }, { descriptor }),
    publishSnapshot: (clawId: string, snapshot: SignedStatement<"MembershipSnapshot">) =>
      call<void>("publishSnapshot", { claw_id: clawId }, { snapshot }),
    /** Long-polls the Gateway mailbox after `cursor`. */
    receiveMail: (
      clawId: string,
      cursor: string | null,
      waitSeconds: number,
      signal?: AbortSignal,
    ) =>
      call<ReceiveMailResponse>(
        "receiveMail",
        { claw_id: clawId },
        undefined,
        `?${new URLSearchParams({ ...(cursor ? { after: cursor } : {}), wait: String(waitSeconds) })}`,
        signal,
        waitSeconds * 1000 + REQUEST_DEADLINE_MS,
      ),
    ackMail: (clawId: string, cursor: string) =>
      call<void>("ackMail", { claw_id: clawId }, { cursor }),
    /** Mails a notice to every owner device (K_gw-signed, no bearer; notices are never authority). */
    sendOwnerNotice: (clawId: string, payload: Extract<MailboxPayload, { kind: "notice" }>) =>
      call<SendMailResponse>("sendMail", { claw_id: clawId }, { to: "owners", payload }),
    /** Mails a notice to one device of this claw, by its key fingerprint. */
    sendDeviceNotice: (
      clawId: string,
      deviceFp: KeyFingerprint,
      payload: Extract<MailboxPayload, { kind: "notice" }>,
    ) => call<SendMailResponse>("sendMail", { claw_id: clawId }, { to: deviceFp, payload }),
  };
}

export type DiscoveryClient = ReturnType<typeof createDiscoveryClient>;
