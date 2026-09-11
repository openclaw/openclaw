export const teamReportsExtensionTestRoots = ["extensions/team-reports"];

export function isTeamReportsExtensionRoot(root) {
  return teamReportsExtensionTestRoots.includes(root);
}
