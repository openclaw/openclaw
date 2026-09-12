export const databaseWorkerExtensionTestRoots = ["extensions/logbook", "extensions/team-reports"];

export function isDatabaseWorkerExtensionRoot(root) {
  return databaseWorkerExtensionTestRoots.includes(root);
}
