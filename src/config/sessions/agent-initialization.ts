import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentMainSessionKey } from "./main-session.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { SessionWorkStartError } from "./session-work-start.js";
import type { InternalSessionEntry } from "./types.js";

/** The canonical Template admission, not an arbitrary session, owns agent readiness. */
export function assertAgentInitializationComplete(entry: InternalSessionEntry | undefined): void {
  if (entry?.initializationPending && entry.templateInitialization) {
    throw new SessionWorkStartError(
      "initialization_pending",
      "This agent's Template setup is still initializing. Retry setup before starting a conversation.",
      true,
    );
  }
}

export async function assertAgentInitializationCompleteInWorker(
  cfg: OpenClawConfig,
  agentId: string,
  assertCurrent: () => void = () => {},
): Promise<void> {
  const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const entry = await readSessionEntryReadOnlyInWorker(
    {
      agentId,
      sessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    },
    assertCurrent,
  );
  assertCurrent();
  assertAgentInitializationComplete(entry);
}
