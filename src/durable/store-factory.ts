import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import type { DurableRuntimeStore } from "./types.js";

export type DurableRuntimeStoreBackend = "sqlite";

export type OpenDurableRuntimeStoreOptions = {
  backend?: DurableRuntimeStoreBackend;
  path?: string;
  env?: NodeJS.ProcessEnv;
};

export function resolveDurableRuntimeStoreBackend(
  env: NodeJS.ProcessEnv = process.env,
): DurableRuntimeStoreBackend {
  const raw = (env.OPENCLAW_DURABLE_RUNTIME_STORE ?? "").trim().toLowerCase();
  if (!raw || raw === "sqlite") {
    return "sqlite";
  }
  throw new Error(`Unsupported durable runtime store backend "${raw}". Supported backends: sqlite`);
}

export function openDurableRuntimeStore(
  options: OpenDurableRuntimeStoreOptions = {},
): DurableRuntimeStore {
  const backend = options.backend ?? resolveDurableRuntimeStoreBackend(options.env);
  switch (backend) {
    case "sqlite":
      return openDurableRuntimeSqliteStore({ path: options.path, env: options.env });
  }
  throw new Error("Unsupported durable runtime store backend. Supported backends: sqlite");
}
