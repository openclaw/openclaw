import type { CliCommandCatalogEntry } from "./command-catalog.js";

// Unlike passive task inspection/admission, these commands execute model tools.
// Activate configured policy hooks and normal execution bootstrap before custody.
export const supervisedTaskCommandEntries: readonly CliCommandCatalogEntry[] = ["run", "work"].map(
  (action): CliCommandCatalogEntry => ({
    commandPath: ["tasks", "supervise", action],
    exact: true,
    policy: {
      configGuard: "run",
      ensureCliPath: true,
      loadPlugins: "always",
      networkProxy: "default",
    },
  }),
);
