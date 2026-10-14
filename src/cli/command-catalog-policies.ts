import type { CliCommandPathPolicy } from "./command-catalog-types.js";

// These commands own their state boundary; bootstrap must not observe or initialize it first.
export const PASSIVE_STARTUP_POLICY = {
  configGuard: "skip",
  loadPlugins: "never",
  ensureCliPath: false,
  networkProxy: "bypass",
} satisfies Partial<CliCommandPathPolicy>;
