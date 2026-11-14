export async function drainScenarioDatabase(databasePath: string) {
  const { waitForSessionTranscriptIndexReconcile } =
    await import("../../config/sessions/session-transcript-reconcile.js");
  const { closeAuthProfileReadPool } = await import("../auth-profiles/sqlite.js");
  try {
    await waitForSessionTranscriptIndexReconcile({ agentId: "test", path: databasePath });
  } finally {
    closeAuthProfileReadPool({ kind: "database", databasePath });
  }
}
