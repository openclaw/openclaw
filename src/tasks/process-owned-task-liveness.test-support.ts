import "./process-owned-task-liveness.js";

type ProcessOwnedTaskLivenessTestApi = {
  resetProcessOwnedTaskLivenessForTests(): void;
};

function getTestApi(): ProcessOwnedTaskLivenessTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.processOwnedTaskLivenessTestApi")
  ];
  if (!api) {
    throw new Error("process-owned task liveness test API is unavailable");
  }
  return api as ProcessOwnedTaskLivenessTestApi;
}

export function resetProcessOwnedTaskLivenessForTests(): void {
  getTestApi().resetProcessOwnedTaskLivenessForTests();
}
