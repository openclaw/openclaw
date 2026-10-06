// Gateway wizard session tracker.
// Tracks active setup/onboarding wizard sessions and purges completed ones.
import type { WizardSession } from "../wizard/session.js";
import type { GatewayClient } from "./server-methods/client-types.js";

const loginOwners = new WeakMap<WizardSession, GatewayClient>();

/** Only credential-login sessions are connection-bound; setup keeps its recovery contract. */
export function bindWizardLoginOwner(session: WizardSession, client: GatewayClient): void {
  loginOwners.set(session, client);
}

export function canAccessWizardSession(
  session: WizardSession,
  client: GatewayClient | null,
): boolean {
  const owner = loginOwners.get(session);
  return !owner || (owner === client && !owner.invalidated && !owner.connectionSignal?.aborted);
}

const UNCOLLECTED_TERMINAL_RETENTION_MS = 5 * 60 * 1000;

/** Creates the in-memory tracker used for active Gateway wizard sessions. */
export function createWizardSessionTracker(options?: { now?: () => number }) {
  const wizardSessions = new Map<string, WizardSession>();
  const terminalSince = new Map<string, number>();
  const now = options?.now ?? Date.now;

  const findRunningWizard = (): string | null => {
    for (const [id, session] of wizardSessions) {
      if (!session.isSettled()) {
        terminalSince.delete(id);
        return id;
      }
      const observedAt = terminalSince.get(id);
      if (observedAt === undefined) {
        terminalSince.set(id, now());
      } else if (now() - observedAt >= UNCOLLECTED_TERMINAL_RETENTION_MS) {
        // Keep a terminal result long enough for its original client to collect
        // it; later starts may reap only an abandoned retained result.
        wizardSessions.delete(id);
        terminalSince.delete(id);
      }
    }
    return null;
  };

  const purgeWizardSession = (id: string) => {
    const session = wizardSessions.get(id);
    if (!session) {
      return;
    }
    if (!session.isSettled()) {
      return;
    }
    wizardSessions.delete(id);
    terminalSince.delete(id);
  };

  return { wizardSessions, findRunningWizard, purgeWizardSession };
}
