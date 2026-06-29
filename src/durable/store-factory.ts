import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";
import type { DurableWorkflowStore } from "./types.js";

export type DurableWorkflowStoreBackend = "sqlite";

export type OpenDurableWorkflowStoreOptions = {
  backend?: DurableWorkflowStoreBackend;
  path?: string;
  env?: NodeJS.ProcessEnv;
};

export function resolveDurableWorkflowStoreBackend(
  env: NodeJS.ProcessEnv = process.env,
): DurableWorkflowStoreBackend {
  const raw = env.OPENCLAW_DURABLE_WORKFLOWS_STORE?.trim().toLowerCase();
  if (!raw || raw === "sqlite") {
    return "sqlite";
  }
  throw new Error(
    `Unsupported durable workflow store backend "${raw}". Supported backends: sqlite`,
  );
}

export function openDurableWorkflowStore(
  options: OpenDurableWorkflowStoreOptions = {},
): DurableWorkflowStore {
  const backend = options.backend ?? resolveDurableWorkflowStoreBackend(options.env);
  switch (backend) {
    case "sqlite":
      return openDurableWorkflowSqliteStore({ path: options.path, env: options.env });
  }
}
