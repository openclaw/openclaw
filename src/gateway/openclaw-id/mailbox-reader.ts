// Reads the claw's Discovery mailbox (store-and-forward). Member and node invite
// redemptions become pending, never admitted; the authority verifies root statements
// and revocations. Every other kind is explicitly refused until its handler exists.
// Device-signed approvals arriving this way are refused (spec section 7).
import {
  MAILBOX_MAX_WAIT_SECONDS,
  type AuthorityEvent,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityAccepted, AuthorityRefusal } from "./authority-result.js";
import type { RedemptionSender } from "./authority.js";
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
  redeemNode: (redemption: unknown) => Promise<AuthorityAccepted | AuthorityRefusal>;
  saveCursor: (cursor: string) => Promise<void>;
};

type ReaderLogger = { info: (message: string) => void; warn: (message: string) => void };

/**
 * Applies one message; returns the authority results for its statements. `settle`
 * runs for each result before the next statement is applied, so a committed change
 * gets its effects even when a later statement in the same message fails. Once
 * `signal` is aborted no further statement is submitted.
 */
export async function applyMailboxMessage(
  message: MailboxMessage,
  sink: Pick<MailboxSink, "submit" | "redeem" | "redeemNode">,
  settle: (result: AuthorityAccepted | AuthorityRefusal) => Promise<void> = async () => {},
  signal?: AbortSignal,
): Promise<Array<AuthorityAccepted | AuthorityRefusal>> {
  const payload = message.payload;
  const results: Array<AuthorityAccepted | AuthorityRefusal> = [];
  const record = async (result: AuthorityAccepted | AuthorityRefusal) => {
    results.push(result);
    await settle(result);
  };
  if (payload.kind === "invite_redemption") {
    if (message.from.account_id === null) {
      await record({
        ok: false,
        code: "audience_mismatch",
        detail: "redeeming account is not the invite audience",
      });
      return results;
    }
    await record(
      await sink.redeem(payload.redemption, {
        account_id: message.from.account_id,
        email: message.from.email,
        display_name: message.from.display_name,
        location_hint: message.location_hint,
      }),
    );
  } else if (payload.kind === "node_redemption") {
    await record(await sink.redeemNode(payload.redemption));
  } else if (payload.kind === "revocation") {
    await record(await sink.submit(payload.revocation));
  } else if (payload.kind === "root_statement") {
    for (const statement of payload.statements) {
      if (signal?.aborted) {
        break;
      }
      await record(await sink.submit(statement));
    }
  } else {
    // An advertised protocol kind is not proof that this Gateway implements it.
    // Refuse unhandled mail through settlement before the reader acknowledges it.
    await record({
      ok: false,
      code: "unsupported",
      detail: `mailbox kind ${payload.kind} is not for the Gateway`,
    });
  }
  return results;
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
          controller.signal,
        );
        // A stopped reader applies nothing, even from a response already in flight.
        if (controller.signal.aborted) {
          return;
        }
        if (!connected) {
          connected = true;
          params.onConnected?.();
        }
        for (const message of batch.messages) {
          if (controller.signal.aborted) {
            return;
          }
          await applyMailboxMessage(
            message,
            params.sink,
            async (result) => {
              if (!result.ok) {
                params.log.warn(
                  `openclaw-id: mailbox ${message.payload.kind} refused (${result.code})`,
                );
                await params
                  .onRefused?.(message, result)
                  .catch((error: unknown) =>
                    params.log.warn(
                      `openclaw-id: mailbox refusal handling failed: ${String(error)}`,
                    ),
                  );
              }
              // A committed change always gets its local effects (closing sessions, revoking tokens).
              if (result.ok) {
                await params.onEffects(result.events);
              }
            },
            controller.signal,
          );
        }
        if (batch.messages.length > 0 && !controller.signal.aborted) {
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
          `openclaw-id: mailbox read failed: ${error instanceof Error ? error.message : String(error)}`,
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
