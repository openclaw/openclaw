// Membership API for owner devices that reach the claw over the tunnel (the
// browser loader's Service Worker, which is not a Gateway WebSocket client).
// Only requests relayed by the tunnel child reach it, so the caller is an
// admitted device whose key W the QUIC handshake authenticated. Every write is
// a signed statement the authority verifies itself (spec sections 6 and 7);
// this layer only decodes JSON and maps refusals to HTTP.
//
//   GET  /_openclaw-id/v1/membership  owner devices: seq, binding, active owner certs, members, invites
//   POST /_openclaw-id/v1/statements  { statement }            MembershipChange, Revocation
//   POST /_openclaw-id/v1/invites     { cap, proof_key }       InviteCap plus base64url proof key
//   POST /_openclaw-id/v1/node-invites { cap, proof_key }      NodeInviteCap plus proof key
//   POST /_openclaw-id/v1/signout     no body                 end this peer's browser credentials
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthorityAccepted, AuthorityRefusal } from "./authority-result.js";
import { decodeInviteProofKey } from "./invites-view.js";

/** Path prefix the tunnel API owns on the claw origin. */
const TUNNEL_API_PREFIX = "/_openclaw-id/v1/";

const MAX_BODY_BYTES = 64 * 1024;

/** What the tunnel API needs from the Gateway's OpenClaw ID owner. */
export type TunnelApiOwner = {
  /** The membership view for an owner device's peer key; undefined for anyone else. */
  membership: (peerKey: string) => Promise<unknown>;
  /** Loads owner authority once; the returned check is synchronous and live. */
  prepareOwnerCheck: (peerKey: string) => Promise<() => boolean>;
  /** Applies a signed statement received over the tunnel. */
  submit: (statement: unknown) => Promise<AuthorityAccepted | AuthorityRefusal>;
  /** Registers an owner-signed InviteCap with its proof key. */
  registerInvite: (input: {
    cap: unknown;
    proofKey: Uint8Array;
  }) => Promise<AuthorityAccepted | AuthorityRefusal>;
  /** Registers an owner-signed NodeInviteCap with its proof key. */
  registerNodeInvite: (
    input: {
      cap: unknown;
      proofKey: Uint8Array;
    },
    isCallerOwner: () => boolean,
  ) => Promise<AuthorityAccepted | AuthorityRefusal>;
  /** Current membership seq, reported after a write so clients can sign the next change. */
  seq: () => Promise<number>;
  /** Revokes browser tokens and closes RPC connections for the authenticated peer only. */
  signOut: (peerKey: string) => Promise<boolean>;
};

type Route = "membership" | "statements" | "invites" | "node-invites" | "signout";

// Refusal code -> HTTP status. Clients match `error.code`, never the status or message.
function refusalStatus(code: string): number {
  if (code === "malformed") {
    return 400;
  }
  if (code === "not_linked") {
    return 404;
  }
  return code === "seq_conflict" || code.startsWith("invite_") ? 409 : 403;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

// Reads a JSON object body of at most MAX_BODY_BYTES; undefined when too large or not an object.
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    // SAFETY: IncomingMessage without setEncoding yields Buffer chunks.
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      return undefined;
    }
    // SAFETY: IncomingMessage without setEncoding yields Buffer chunks.
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    // SAFETY: checked above to be a non-null, non-array object; handlers validate each field.
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function routeOf(url: string | undefined): Route | undefined {
  const pathname = new URL(url ?? "/", "http://claw.invalid").pathname;
  if (!pathname.startsWith(TUNNEL_API_PREFIX)) {
    return undefined;
  }
  const name = pathname.slice(TUNNEL_API_PREFIX.length);
  return name === "membership" ||
    name === "statements" ||
    name === "invites" ||
    name === "node-invites" ||
    name === "signout"
    ? name
    : undefined;
}

// Answers an accepted write, or maps a refusal to its HTTP status.
async function answerWrite(
  res: ServerResponse,
  owner: TunnelApiOwner,
  result: AuthorityAccepted | AuthorityRefusal,
): Promise<void> {
  if (!result.ok) {
    sendError(res, refusalStatus(result.code), result.code, result.detail);
    return;
  }
  sendJson(res, 200, { status: result.status, seq: await owner.seq() });
}

/** True when the request path belongs to the tunnel API. */
export function isTunnelApiRequest(req: IncomingMessage): boolean {
  return (req.url ?? "").startsWith(TUNNEL_API_PREFIX);
}

/**
 * Serves one tunnel API request from the admitted device `peerKey`. The caller
 * has already checked the request came through the tunnel child.
 */
export async function handleTunnelApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  peerKey: string,
  owner: TunnelApiOwner,
): Promise<void> {
  const route = routeOf(req.url);
  if (!route) {
    sendError(res, 404, "not_found", "no such OpenClaw ID endpoint");
    return;
  }
  const method = route === "membership" ? "GET" : "POST";
  if (req.method !== method) {
    res.setHeader("allow", method);
    sendError(res, 405, "method_not_allowed", `use ${method}`);
    return;
  }
  if (route === "membership") {
    const view = await owner.membership(peerKey);
    if (!view) {
      sendError(res, 403, "not_owner_device", "only owner devices read membership");
      return;
    }
    sendJson(res, 200, view);
    return;
  }
  if (route === "signout") {
    if (!(await owner.signOut(peerKey))) {
      sendError(res, 403, "not_admitted", "this device is not admitted");
      return;
    }
    sendJson(res, 200, { signedOut: true });
    return;
  }
  const body = await readJsonObject(req);
  if (!body) {
    sendError(res, 400, "malformed", "expected a JSON object of at most 64 KiB");
    return;
  }
  if (route === "statements") {
    if (!body.statement) {
      sendError(res, 400, "malformed", "statement is required");
      return;
    }
    await answerWrite(res, owner, await owner.submit(body.statement));
    return;
  }
  const proofKey = decodeInviteProofKey(body.proof_key);
  if (!body.cap || !proofKey) {
    sendError(res, 400, "malformed", "cap and a 32-byte base64url proof_key are required");
    return;
  }
  if (route === "node-invites") {
    const isOwner = await owner.prepareOwnerCheck(peerKey);
    if (!isOwner()) {
      sendError(res, 403, "not_owner_device", "only owner devices register node invites");
      return;
    }
    await answerWrite(
      res,
      owner,
      await owner.registerNodeInvite({ cap: body.cap, proofKey }, isOwner),
    );
    return;
  }
  await answerWrite(res, owner, await owner.registerInvite({ cap: body.cap, proofKey }));
}
