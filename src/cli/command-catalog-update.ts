import { PASSIVE_STARTUP_POLICY } from "./command-catalog-policies.js";
import type { CliCommandCatalogEntry } from "./command-catalog-types.js";

/** Update commands retain their own config, state, and protocol admission boundaries. */
export const updateCommandCatalog: readonly CliCommandCatalogEntry[] = [
  {
    commandPath: ["update", "cleanup"],
    exact: true,
    policy: { ...PASSIVE_STARTUP_POLICY, hideBanner: true },
  },
  {
    commandPath: ["update"],
    policy: { configGuard: "skip", hideBanner: true },
  },
  {
    commandPath: ["update", "admit"],
    // Malformed internal argv must keep protocol stdout and read-only startup policy too.
    policy: { ...PASSIVE_STARTUP_POLICY, hideBanner: true, ownsProtocolStdout: true },
  },
];
