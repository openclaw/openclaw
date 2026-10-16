import { formatUiError } from "../../lib/format-error.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { CreationComposerTransfer } from "../new-session/creation-composer.ts";
import { setChatError } from "./chat-history-state.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { admitCreatedComposerQueue } from "./creation-composer-handoff.ts";

/** Resume on Gateway publications, never by polling or replaying a settled batch. */
export function connectCreatedComposerQueue(
  context: { gateway: { subscribe(listener: () => void): () => void } },
  host: ChatHost,
  transfer: CreationComposerTransfer,
): () => void {
  let disposed = false;
  let finished = false;
  let running = false;
  let changedWhileRunning = false;
  const sync = () => {
    if (
      disposed ||
      finished ||
      !areUiSessionKeysEquivalent(host.sessionKey, transfer.sessionKey) ||
      !transfer.isCurrent()
    ) {
      return;
    }
    if (running) {
      changedWhileRunning = true;
      return;
    }
    if (!host.connected || !host.client?.recoveryScopeReady) {
      return;
    }
    running = true;
    changedWhileRunning = false;
    void admitCreatedComposerQueue(host, transfer)
      .then((complete) => {
        finished = complete;
      })
      .catch((error: unknown) => {
        finished = true;
        if (transfer.isCurrent()) {
          setChatError(host, formatUiError(error));
        }
      })
      .finally(() => {
        running = false;
        if (changedWhileRunning) {
          sync();
        }
      });
  };
  const unsubscribe = context.gateway.subscribe(sync);
  sync();
  return () => {
    disposed = true;
    unsubscribe();
  };
}
