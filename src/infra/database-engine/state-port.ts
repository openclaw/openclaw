import os from "node:os";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const statePortProvider: DatabasePortProvider = {
  id: "state",
  minimumPostgresVersion: 16,
  async loadDescriptor(_owner, version) {
    const { loadStatePortDescriptor } = await import("./state-port-descriptor.js");
    return loadStatePortDescriptor(version);
  },
  matchesSqlite: (tables) =>
    ["schema_meta", "config_machine_state", "audit_events"].every((table) => tables.has(table)),
  resolveRoots: resolveStatePortRoots,
};

/** Shared-state discovery is also used before plugin metadata can read the state store. */
export function resolveStatePortRoots(
  context: Pick<Parameters<DatabasePortProvider["resolveRoots"]>[0], "config" | "stateDir" | "env">,
): string[] {
  const roots = [context.stateDir, path.join(context.stateDir, "voice-calls")];
  // Retained stores outlive Voice Call installation. Read its public config path
  // contract without requiring the optional plugin or activating its runtime.
  for (const id of ["voice-call", "@openclaw/voice-call"]) {
    const store = asOptionalRecord(context.config.plugins?.entries?.[id]?.config)?.store;
    if (typeof store === "string" && store.trim()) {
      roots.push(
        path.resolve(
          store.trim().replace(/^~(?=$|[\\/])/, () => context.env.HOME?.trim() || os.homedir()),
        ),
      );
    }
  }
  // Matrix account/token roots have their own R18 discovery and custody owner.
  return [...new Set(roots.map((root) => path.resolve(root, "state", "openclaw.sqlite")))];
}
