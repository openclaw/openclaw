export type SidebarSnapshotScope = {
  gatewayScope: string;
  recoveryScope: string;
  profileId: string | null;
};

export function sidebarSnapshotScopeKey(scope: SidebarSnapshotScope): string | null {
  return scope.gatewayScope && scope.recoveryScope
    ? `scope:${JSON.stringify([scope.gatewayScope, scope.recoveryScope])}\u0000sidebar:${JSON.stringify(scope.profileId)}`
    : null;
}
