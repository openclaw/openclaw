import type { WizardSession } from "../wizard/session.js";

export function createWizardSessionTracker() {
  const wizardSessions = new Map<string, WizardSession>();

  const findRunningWizard = (): string | null => {
    for (const [id, session] of wizardSessions) {
      if (session.getStatus() === "running") return id;
    }
    return null;
  };

  const purgeWizardSession = (id: string) => {
    const session = wizardSessions.get(id);
    if (!session) return;
    if (session.getStatus() === "running") return;
    wizardSessions.delete(id);
  };

  return { wizardSessions, findRunningWizard, purgeWizardSession };
}
