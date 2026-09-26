// Native activation outcomes for loaded, absent, and re-unloaded jobs.
export const launchAgentActivationRecoveryCases = (["start", "restart"] as const).flatMap(
  (action) =>
    [
      { phase: "loaded", detail: "", preserveDefinition: true },
      { phase: "loaded", detail: "Input/output error", preserveDefinition: true },
      { phase: "stopped", detail: "", preserveDefinition: true },
      { phase: "stopped", detail: "Could not find service", preserveDefinition: true },
      { phase: "stopped", detail: "Input/output error", preserveDefinition: true },
      { phase: "stopped", detail: "Input/output error", preserveDefinition: false },
      {
        phase: "bootstrap-kickstart",
        detail: "Could not find service",
        preserveDefinition: true,
      },
    ].map(({ phase, detail, preserveDefinition }) => ({
      action,
      phase,
      detail,
      preserveDefinition,
    })),
);
