import { createRequire } from "node:module";

export const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

export type UndiciRuntimeDeps = {
  Agent: typeof import("undici").Agent;
  EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
  ProxyAgent: typeof import("undici").ProxyAgent;
};

function isUndiciRuntimeDeps(value: unknown): value is UndiciRuntimeDeps {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UndiciRuntimeDeps).Agent === "function" &&
    typeof (value as UndiciRuntimeDeps).EnvHttpProxyAgent === "function" &&
    typeof (value as UndiciRuntimeDeps).ProxyAgent === "function"
  );
}

export function loadUndiciRuntimeDeps(): UndiciRuntimeDeps {
  const override = (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  if (isUndiciRuntimeDeps(override)) {
    return override;
  }

  const require = createRequire(import.meta.url);
  const undici = require("undici") as typeof import("undici");
  return {
    Agent: undici.Agent,
    EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
    ProxyAgent: undici.ProxyAgent,
  };
}
