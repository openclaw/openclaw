import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/restart-resume");

/** Count unique sessions, including candidates that never reached the writer. */
export function createRestartResumeSummary(phase: "shutdown" | "startup") {
  const agents = new Map<string, Map<string, string>>();
  let published = false;
  return {
    record(agentId: string, sessionKey: string, outcome: string) {
      let sessions = agents.get(agentId);
      if (!sessions) {
        sessions = new Map();
        agents.set(agentId, sessions);
      }
      sessions.set(sessionKey, outcome);
    },
    publish() {
      if (published) {
        return;
      }
      published = true;
      const success = phase === "shutdown" ? "marked" : "resumed";
      const counts = [...agents].map(([agentId, sessions]) => {
        const reasons: Record<string, number> = {};
        for (const outcome of sessions.values()) {
          reasons[outcome] = (reasons[outcome] ?? 0) + 1;
        }
        const completed = reasons[success] ?? 0;
        delete reasons[success];
        return { agentId, [success]: completed, skipped: sessions.size - completed, reasons };
      });
      log.info(`${phase} restart resume: ${JSON.stringify(counts)}`);
    },
  };
}
