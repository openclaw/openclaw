import type { OpenClawConfig } from "../config/types.js";
import { formatDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics-format.js";
import type { DatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics.js";

export type StatusDatabaseEngines = {
  source: "admitted" | "unavailable";
  stores: DatabaseStoreDiagnostic[];
  reason?: string;
};

/** Status consumes retained facts; only Doctor performs physical inspections. */
export async function resolveStatusDatabaseEngines(
  config: OpenClawConfig,
  stores?: DatabaseStoreDiagnostic[],
): Promise<StatusDatabaseEngines> {
  if (stores) {
    return { source: "admitted", stores };
  }
  try {
    const { isImplicitLocalGatewayTarget } = await import("../gateway/call.js");
    if (!(await isImplicitLocalGatewayTarget({ config }))) {
      return {
        source: "unavailable",
        stores: [],
        reason:
          "Physical stores unknown: the selected Gateway has not supplied admitted database facts. Run openclaw doctor on the Gateway host.",
      };
    }
    const { describeAdmittedDatabaseStores } =
      await import("../infra/database-engine/admitted-diagnostics.js");
    return {
      source: "admitted",
      stores: describeAdmittedDatabaseStores(config),
    };
  } catch {
    // Never include raw errors: configuration failures may contain a connection secret.
    return {
      source: "unavailable",
      stores: [],
      reason:
        "Physical stores unknown: admitted facts unavailable. Run openclaw doctor for recovery steps.",
    };
  }
}

export function buildStatusDatabaseStoreRows(inspection?: StatusDatabaseEngines) {
  if (!inspection) {
    return [];
  }
  return [
    ...inspection.stores.map((store) => ({
      Item: `Database ${store.family}`,
      Value: formatDatabaseStoreDiagnostic(store),
    })),
    ...(inspection.reason ? [{ Item: "Database stores", Value: inspection.reason }] : []),
  ];
}
