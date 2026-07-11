// Gateway wizard session tracker.
// Tracks active setup/onboarding wizard sessions and purges completed ones.
import type { WizardSession } from "../wizard/session.js";

/** Creates the in-memory tracker used for active Gateway wizard sessions. */
export function createWizardSessionTracker() {
  const wizardSessions = new Map<string, WizardSession>();

  const findRunningWizard = (): string | null => {
    for (const [id, session] of wizardSessions) {
      if (session.getStatus() === "running") {
        return id;
      }
      // Immediate-return clients may disconnect before collecting a terminal
      // result. Reap it on the next start so abandoned sessions stay bounded.
      wizardSessions.delete(id);
    }
    return null;
  };

  const purgeWizardSession = (id: string) => {
    const session = wizardSessions.get(id);
    if (!session) {
      return;
    }
    if (session.getStatus() === "running") {
      return;
    }
    wizardSessions.delete(id);
  };

  return { wizardSessions, findRunningWizard, purgeWizardSession };
}
