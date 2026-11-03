// Reads the claw's Discovery mailbox (store-and-forward). Only three kinds are
// accepted: invite redemptions (which become pending, never admitted), and
// root-signed statements and revocations. The authority verifies each one; a
// device-signed approval that arrives this way is refused (spec section 7).
import {
  GATEWAY_MAILBOX_KINDS,
  MAILBOX_MAX_WAIT_SECONDS,
  type AuthorityEvent,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityAccepted, AuthorityRefusal, RedemptionSender } from "./authority.js";
import type { DiscoveryClient } from "./discovery-client.js";

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

/** Where accepted mailbox writes go. */
export type MailboxSink = {
  submit: (statement: unknown) => Promise<AuthorityAccepted | AuthorityRefusal>;
  redeem: (
    redemption: unknown,
    sender: RedemptionSender,
  ) => Promise<AuthorityAccepted | AuthorityRefusal>;
  saveCursor: (cursor: string) => Promise<void>;
};

type ReaderLogger = { info: (message: string) => void; warn: (message: string) => void };

/** Applies one message; returns the authority results for its statements. */
export async function applyMailboxMessage(
  message: MailboxMessage,
  sink: Pick<MailboxSink, "submit" | "redeem">,
): Promise<Array<AuthorityAccepted | AuthorityRefusal>> {
  const payload = message.payload;
  if (!(GATEWAY_MAILBOX_KINDS as readonly string[]).includes(payload.kind)) {
    return [
      {
        ok: false,
        code: "unsupported",
        detail: `mailbox kind ${payload.kind} is not for the Gateway`,
      },
    ];
  }
  if (payload.kind === "invite_redemption") {
    return [
      await sink.redeem(payload.redemption, {
        account_id: message.from.account_id,
        email: message.from.email,
        display_name: message.from.display_name,
        location_hint: message.location_hint,
      }),
    ];
  }
  if (payload.kind === "revocation") {
    return [await sink.submit(payload.revocation)];
  }
  if (payload.kind === "root_statement") {
    const results: Array<AuthorityAccepted | AuthorityRefusal> = [];
    for (const statement of payload.statements) {
      results.push(await sink.submit(statement));
    }
    return results;
  }
  return [];
}

/**
 * Long-polls the mailbox until stopped; acknowledges what it applied. `onEffects`
 * receives the side effects of accepted writes. `onRefused` sees each refusal with
 * its message, so the Gateway can react (a stale seq means Discovery's mirror is
 * behind). `onConnected` runs on the first successful read and after each
 * recovery from a failed read: Discovery is reachable again.
 */
export function startMailboxReader(params: {
  clawId: string;
  client: DiscoveryClient;
  sink: MailboxSink;
  cursor: string | null;
  onEffects: (events: AuthorityEvent[]) => Promise<void>;
  onRefused?: (message: MailboxMessage, refusal: AuthorityRefusal) => Promise<void>;
  onConnected?: () => void;
  log: ReaderLogger;
}) {
  const controller = new AbortController();
  let cursor = params.cursor;
  const loop = async () => {
    let backoff = BACKOFF_INITIAL_MS;
    let connected = false;
    while (!controller.signal.aborted) {
      try {
        const batch = await params.client.receiveMail(
          params.clawId,
          cursor,
          MAILBOX_MAX_WAIT_SECONDS,
        );
        if (!connected) {
          connected = true;
          params.onConnected?.();
        }
        for (const message of batch.messages) {
          for (const result of await applyMailboxMessage(message, params.sink)) {
            if (!result.ok) {
              params.log.warn(
                `openclaw-id: mailbox ${message.payload.kind} refused (${result.code})`,
              );
              await params
                .onRefused?.(message, result)
                .catch((error: unknown) =>
                  params.log.warn(`openclaw-id: mailbox refusal handling failed: ${String(error)}`),
                );
            }
            if (result.ok) {
              await params.onEffects(result.events);
            }
          }
        }
        if (batch.messages.length > 0) {
          await params.client.ackMail(params.clawId, batch.cursor);
          await params.sink.saveCursor(batch.cursor);
        }
        cursor = batch.cursor;
        backoff = BACKOFF_INITIAL_MS;
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        connected = false;
        params.log.warn(
          `openclaw-id: mailbox read failed: ${String((error as Error)?.message ?? error)}`,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, backoff).unref();
        });
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      }
    }
  };
  void loop();
  return {
    stop(): void {
      controller.abort();
    },
  };
}
