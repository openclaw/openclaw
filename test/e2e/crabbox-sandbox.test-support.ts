export function resolveLiveCrabboxSandboxConfig(env: NodeJS.ProcessEnv) {
  return {
    provider: env.OPENCLAW_E2E_CRABBOX_PROVIDER,
    class: env.OPENCLAW_E2E_CRABBOX_CLASS?.trim() || "tiny",
    // Admission and provisioning must use the same executable, including when a sibling build exists.
    binary: env.OPENCLAW_E2E_CRABBOX_BINARY?.trim() || "crabbox",
    ttl: "30m",
    idleTimeout: "15m",
  };
}

export function assertLiveCrabboxClassSizing(configJson: string) {
  try {
    const config = JSON.parse(configJson) as { serverTypeExplicit?: boolean } | null;
    if (config?.serverTypeExplicit === false) {
      return;
    }
  } catch {
    // Config output can contain secrets; report the admission failure without echoing it.
  }
  throw new Error(
    "Before provisioning, clear CRABBOX_SERVER_TYPE and explicit server type settings in Crabbox config. " +
      "Select a class with OPENCLAW_E2E_CRABBOX_CLASS, or upgrade Crabbox if config show cannot verify class-based sizing.",
  );
}
