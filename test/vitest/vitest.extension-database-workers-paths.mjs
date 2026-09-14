export const databaseWorkerExtensionTestRoots = [
  "extensions/logbook",
  "extensions/team-reports",
  "extensions/workboard",
];

export const databaseWorkerExtensionTestFiles = [
  "extensions/google-meet/index.create.test.ts",
  "extensions/google-meet/index.test.ts",
  "extensions/imessage/src/approval-reactions.persistence.test.ts",
  "extensions/teams-meetings/index.test.ts",
  "extensions/teams-meetings/src/runtime-node.test.ts",
  "extensions/teams-meetings/src/runtime.test.ts",
  "extensions/zoom-meetings/index.test.ts",
  "extensions/zoom-meetings/src/runtime-node.test.ts",
  "extensions/zoom-meetings/src/runtime.test.ts",
];

export function isDatabaseWorkerExtensionRoot(root) {
  return databaseWorkerExtensionTestRoots.includes(root);
}
