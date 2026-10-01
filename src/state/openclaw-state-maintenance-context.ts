import { AsyncLocalStorage } from "node:async_hooks";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type MaintenanceResource = {
  phase:
    | "agent-resources"
    | "agent-handles"
    | "shared-leases"
    | "shared-resources"
    | "shared-references"
    | "shared-handles";
  close: () => void | Promise<void>;
};

export type AgentSchemaMigration = {
  agentId: string;
  path: string;
  foundVersion: number;
  supportedVersion: number;
};

export type OpenClawDatabaseMaintenanceScope = {
  readonly ownsSchemaMaintenance: boolean;
  assertOwnerCurrent(this: void, access?: "read"): void;
  assertDatabaseAccess(this: void, databasePath: string): void;
  assertAdmission(this: void): void;
  assertReadAdmission(this: void): void;
  addAgentSchemaMigrationCheck(check: (migration: AgentSchemaMigration) => void): void;
  assertAgentSchemaMigration(migration: AgentSchemaMigration): void;
  run<T>(operation: () => T): T;
  track<T>(operation: Promise<T>): Promise<T>;
  own(
    resource: object,
    phase: MaintenanceResource["phase"],
    close: MaintenanceResource["close"],
  ): void;
  close(): Promise<void>;
};

const liveAuthorityReads = resolveGlobalSingleton(
  Symbol.for("openclaw.maintenanceLiveAuthorityReads"),
  () => new WeakMap<OpenClawDatabaseMaintenanceScope, Set<string>>(),
);

export function allowsMaintenanceLiveAuthorityReads(
  scope: OpenClawDatabaseMaintenanceScope,
  pathname: string,
): boolean {
  const canonicalPath = resolveIdentityPathViaExistingAncestorSync(pathname);
  for (
    let current: OpenClawDatabaseMaintenanceScope | undefined = scope;
    current;
    current = maintenanceResources.parents.get(current)
  ) {
    if (liveAuthorityReads.get(current)?.has(canonicalPath)) {
      return true;
    }
  }
  return false;
}

export const maintenanceResources = resolveGlobalSingleton(
  Symbol.for("openclaw.databaseMaintenanceResources"),
  () => ({
    current: new AsyncLocalStorage<{ scope: OpenClawDatabaseMaintenanceScope; active: boolean }>(),
    claims: new WeakMap<
      object,
      MaintenanceResource & { scope: OpenClawDatabaseMaintenanceScope; release: () => void }
    >(),
    parents: new WeakMap<OpenClawDatabaseMaintenanceScope, OpenClawDatabaseMaintenanceScope>(),
  }),
);

export function getOpenClawDatabaseMaintenanceScope():
  | OpenClawDatabaseMaintenanceScope
  | undefined {
  return maintenanceResources.current.getStore()?.scope;
}

/** Doctor selects live source reads only after its pre-mutation backup boundary. */
export function admitOpenClawMaintenanceLiveAuthorityReads(pathname: string): void {
  const scope = getOpenClawDatabaseMaintenanceScope();
  if (!scope?.ownsSchemaMaintenance) {
    throw new Error("Live authority reads require database maintenance ownership");
  }
  scope.assertDatabaseAccess(pathname);
  let admitted = liveAuthorityReads.get(scope);
  if (!admitted) {
    admitted = new Set();
    liveAuthorityReads.set(scope, admitted);
  }
  admitted.add(resolveIdentityPathViaExistingAncestorSync(pathname));
}

/** Delayed work acquires its own resources instead of inheriting the completed scope. */
export function runOutsideOpenClawDatabaseMaintenanceScope<T>(operation: () => T): T {
  return maintenanceResources.current.exit(operation);
}

export function isOpenClawDatabaseMaintenanceResourceOwned(
  resource: object,
  scope: OpenClawDatabaseMaintenanceScope,
): boolean {
  return maintenanceResources.claims.get(resource)?.scope === scope;
}

export function getOpenClawDatabaseMaintenanceResourceScope(
  resource: object,
): OpenClawDatabaseMaintenanceScope | undefined {
  return maintenanceResources.claims.get(resource)?.scope;
}

export function runMaintenance<T>(scope: OpenClawDatabaseMaintenanceScope, operation: () => T): T {
  const accepted = { scope, active: true };
  try {
    const result = maintenanceResources.current.run(accepted, operation);
    if (result instanceof Promise) {
      const settled = () => {
        accepted.active = false;
      };
      void result.then(settled, settled);
      void scope.track(result);
    } else {
      accepted.active = false;
    }
    return result;
  } catch (error) {
    accepted.active = false;
    throw error;
  }
}

/** Retain one exact resource claim for finite commands while its maintenance scope drains. */
export function captureOpenClawDatabaseMaintenanceResource(
  resource: object,
  expectedScope: OpenClawDatabaseMaintenanceScope,
) {
  const claim = maintenanceResources.claims.get(resource);
  const assertCurrent = () => {
    expectedScope.assertOwnerCurrent();
    if (claim?.scope !== expectedScope || maintenanceResources.claims.get(resource) !== claim) {
      throw new Error("Database maintenance resource owner changed");
    }
  };
  assertCurrent();
  return {
    assertCurrent,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertCurrent();
      return runMaintenance(expectedScope, operation);
    },
  };
}

/** A cached handle used by an independent caller remains with the ordinary cache owner. */
export function observeOpenClawDatabaseMaintenanceResource(resource: object | undefined): void {
  if (!resource) {
    return;
  }
  const claim = maintenanceResources.claims.get(resource);
  const current = getOpenClawDatabaseMaintenanceScope();
  if (!claim) {
    return;
  }
  const owner = commonMaintenanceAncestor(claim.scope, current);
  if (owner === claim.scope) {
    return;
  }
  claim.scope.assertAdmission();
  claim.release();
  maintenanceResources.claims.delete(resource);
  if (owner) {
    owner.own(resource, claim.phase, claim.close);
  }
}

function commonMaintenanceAncestor(
  owner: OpenClawDatabaseMaintenanceScope,
  scope: OpenClawDatabaseMaintenanceScope | undefined,
): OpenClawDatabaseMaintenanceScope | undefined {
  const ancestors = new Set<OpenClawDatabaseMaintenanceScope>();
  for (
    let current: OpenClawDatabaseMaintenanceScope | undefined = owner;
    current;
    current = maintenanceResources.parents.get(current)
  ) {
    ancestors.add(current);
  }
  for (let current = scope; current; current = maintenanceResources.parents.get(current)) {
    if (ancestors.has(current)) {
      return current;
    }
  }
  return undefined;
}
