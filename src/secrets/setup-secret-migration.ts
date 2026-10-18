import { ENV_SECRET_REF_ID_RE } from "./ref-contract.js";
import type { readSelectedSecretStoreEntries } from "./store/secret-store.js";

export type SetupSecretMigrationInspection = {
  name: string;
  status: "ready" | "missing" | "missing-bindings" | "conflicting-value" | "unavailable";
};

/** The host compares legacy values; plugin repair receives no secret material. */
export async function inspectSetupSecretMigration(params: {
  names: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<SetupSecretMigrationInspection[]> {
  const names = [...new Set(params.names)];
  if (names.length > 16) {
    throw new Error("Setup secret migration inspection must contain at most 16 names.");
  }
  const validNames = names.filter((name) => ENV_SECRET_REF_ID_RE.test(name));
  if (validNames.length === 0) {
    return names.map((name) => ({ name, status: "missing" }));
  }
  let entries: Awaited<ReturnType<typeof readSelectedSecretStoreEntries>>;
  try {
    const { readSelectedSecretStoreEntries } = await import("./store/secret-store.js");
    entries = await readSelectedSecretStoreEntries({
      names: validNames,
      database: { env: params.env },
    });
  } catch {
    return names.map((name) => ({ name, status: "unavailable" }));
  }
  const selected = new Map(entries.map((entry) => [entry.name, entry]));
  return names.map((name) => {
    const entry = selected.get(name);
    const status = !entry
      ? "missing"
      : !entry.allowedHosts.length
        ? "missing-bindings"
        : Object.hasOwn(params.env, name) && params.env[name] !== entry.value
          ? "conflicting-value"
          : "ready";
    return { name, status };
  });
}
