import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import type { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";

export async function captureFreshManagedServiceAdmission(params: {
  root: string;
  owned: boolean;
  writable: boolean;
  restart: boolean;
}): Promise<Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>>> {
  return {
    service: params.owned
      ? {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceNodeRunner: "/service/node",
          serviceMutationAllowed: params.restart,
          serviceUpdateVerdict: {
            kind: "owned",
            root: params.root,
            fingerprint: "fixture",
            refreshDefinition: params.writable,
          },
        }
      : undefined,
    services: new Map(),
    contexts: [await captureTargetDatabaseSchemaContext(process.env)],
    managedEnv: undefined,
  };
}
