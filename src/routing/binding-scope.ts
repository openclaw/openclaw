export type RouteBindingScopeConstraint = {
  guildId?: string | null;
  teamId?: string | null;
  roles?: string[] | null;
};

export type RouteBindingScope = {
  guildId?: string | null;
  teamId?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: Iterable<string> | null;
};

export function normalizeRouteBindingId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

export function normalizeRouteBindingRoles(value: string[] | null | undefined): string[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function scopeIdMatches(params: {
  constraint: string | null | undefined;
  exact: string;
  groupSpace: string;
}): boolean {
  if (!params.constraint) {
    return true;
  }
  return params.constraint === params.exact || params.constraint === params.groupSpace;
}

export function routeBindingScopeMatches(
  constraint: RouteBindingScopeConstraint,
  scope: RouteBindingScope,
): boolean {
  const guildId = normalizeRouteBindingId(scope.guildId);
  const teamId = normalizeRouteBindingId(scope.teamId);
  const groupSpace = normalizeRouteBindingId(scope.groupSpace);
  if (!scopeIdMatches({ constraint: constraint.guildId, exact: guildId, groupSpace })) {
    return false;
  }
  if (!scopeIdMatches({ constraint: constraint.teamId, exact: teamId, groupSpace })) {
    return false;
  }

  const roles = normalizeRouteBindingRoles(constraint.roles);
  if (!roles) {
    return true;
  }
  const memberRoleIds = new Set(scope.memberRoleIds ?? []);
  return roles.some((role) => memberRoleIds.has(role));
}
