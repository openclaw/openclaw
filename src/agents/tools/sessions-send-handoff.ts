import fs from "node:fs/promises";
import path from "node:path";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN, isSilentReplyText } from "../../auto-reply/tokens.js";
import { resolveStateDir } from "../../config/paths.js";
import { ANNOUNCE_SKIP_TOKEN, REPLY_SKIP_TOKEN } from "./sessions-send-tokens.js";

export const SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH = "handoffs/sessions-send.jsonl";

export type SessionsSendHandoffStatus = "queued" | "accepted" | "delivered" | "rejected";

export type SessionsSendHandoffControlOutcome =
  | "announce_skip"
  | "heartbeat_ok"
  | "no_reply"
  | "reply_skip";

export type SessionsSendHandoffDelivery = {
  mode: "announce";
  status: "pending" | "skipped";
};

export type SessionsSendHandoffAck = {
  id: string;
  status: SessionsSendHandoffStatus;
  delivery: SessionsSendHandoffDelivery;
  ledger: {
    path: typeof SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH;
  };
};

export type SessionsSendHandoffEventType =
  | "accepted"
  | "announce_delivered"
  | "announce_delivery_failed"
  | "control_outcome_observed"
  | "created"
  | "failed"
  | "rejected"
  | "target_reply_missing"
  | "target_reply_observed";

export type SessionsSendHandoffEvent = {
  handoffId: string;
  type: SessionsSendHandoffEventType;
  status: SessionsSendHandoffStatus;
  runId?: string | undefined;
  requesterSessionKey?: string | undefined;
  requesterChannel?: string | undefined;
  targetSessionKey?: string | undefined;
  targetDisplayKey?: string | undefined;
  targetChannel?: string | undefined;
  controlOutcome?: SessionsSendHandoffControlOutcome | undefined;
  error?: string | undefined;
  timestamp?: string | undefined;
};

export function buildSessionsSendHandoffAck(params: {
  id: string;
  status: SessionsSendHandoffStatus;
  delivery: SessionsSendHandoffDelivery;
}): SessionsSendHandoffAck {
  return {
    id: params.id,
    status: params.status,
    delivery: params.delivery,
    ledger: {
      path: SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH,
    },
  };
}

export function resolveSessionsSendHandoffLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH);
}

export function classifySessionsSendControlOutcome(
  text?: string,
): SessionsSendHandoffControlOutcome | undefined {
  if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
    return "no_reply";
  }
  if (isSilentReplyText(text, REPLY_SKIP_TOKEN)) {
    return "reply_skip";
  }
  if (isSilentReplyText(text, ANNOUNCE_SKIP_TOKEN)) {
    return "announce_skip";
  }
  if (isSilentReplyText(text, HEARTBEAT_TOKEN)) {
    return "heartbeat_ok";
  }
  return undefined;
}

export async function recordSessionsSendHandoffEvent(
  event: SessionsSendHandoffEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const ledgerPath = resolveSessionsSendHandoffLedgerPath(env);
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(
      ledgerPath,
      `${JSON.stringify({
        ...event,
        timestamp: event.timestamp ?? new Date().toISOString(),
      })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // Handoff ledger writes are audit best-effort; tool delivery must not fail
    // because the local state directory is temporarily unavailable.
  }
}
