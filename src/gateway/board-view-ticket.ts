import { createHmac, randomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";

export const BOARD_HTTP_PATH_PREFIX = "/__openclaw__/board/";
export const BOARD_VIEW_TICKET_TTL_MS = 2 * 60_000;

const BOARD_VIEW_TICKET_SCOPE = "board-widget-view";
const ticketSecret = randomBytes(32);

export type BoardViewTicket = {
  ticket: string;
  expiresAtMs: number;
};

export type BoardViewTicketBinding = {
  sessionKey: string;
  name: string;
  revision: number;
  expiresAtMs: number;
};

function signTicket(
  nonce: string,
  expiresAtMs: number,
  binding: Omit<BoardViewTicketBinding, "expiresAtMs">,
  secret: Buffer,
): string {
  return createHmac("sha256", secret)
    .update(
      `${BOARD_VIEW_TICKET_SCOPE}\0${nonce}\0${expiresAtMs}\0${binding.sessionKey}\0${binding.name}\0${binding.revision}`,
    )
    .digest("base64url");
}

export function createBoardViewTicket(params: {
  sessionKey: string;
  name: string;
  revision: number;
  nowMs?: number;
}): BoardViewTicket {
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(params.revision)) {
    throw new Error("invalid board view ticket binding");
  }
  const expiresAtMs = nowMs + BOARD_VIEW_TICKET_TTL_MS;
  const nonce = randomBytes(24).toString("base64url");
  const signature = signTicket(nonce, expiresAtMs, params, ticketSecret);
  return {
    ticket: `v1.${nonce}.${expiresAtMs}.${signature}`,
    expiresAtMs,
  };
}

export function verifyBoardViewTicket(
  value: string,
  expected: {
    sessionKey: string;
    name: string;
    revision: number;
    nowMs?: number;
  },
): BoardViewTicketBinding | undefined {
  const nowMs = expected.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expected.revision)) {
    return undefined;
  }
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return undefined;
  }
  const [, nonce, rawExpiresAtMs, signature] = parts;
  if (!nonce || nonce.length !== 32 || !rawExpiresAtMs || !signature) {
    return undefined;
  }
  const expiresAtMs = Number(rawExpiresAtMs);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
    return undefined;
  }
  const expectedSignature = signTicket(nonce, expiresAtMs, expected, ticketSecret);
  if (!safeEqualSecret(signature, expectedSignature)) {
    return undefined;
  }
  return {
    sessionKey: expected.sessionKey,
    name: expected.name,
    revision: expected.revision,
    expiresAtMs,
  };
}

export function buildBoardWidgetFrameUrl(params: {
  sessionKey: string;
  name: string;
  ticket: string;
}): string {
  return `${BOARD_HTTP_PATH_PREFIX}${encodeURIComponent(params.sessionKey)}/${encodeURIComponent(params.name)}/index.html?bt=${encodeURIComponent(params.ticket)}`;
}
