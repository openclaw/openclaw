function record(value: unknown): Record<string, unknown> {
  // SAFETY: the guard excludes null/arrays; fields remain unknown until validated.
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function label(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "unknown";
}

function latestResponse(observations: unknown[], method: string) {
  const observation = observations.findLast((value) => {
    const item = record(value);
    return item.action === "browser-rpc" && item.method === method;
  });
  const frame = record(record(observation).frame);
  return {
    observed: observation !== undefined,
    ok: typeof frame.ok === "boolean" ? frame.ok : null,
    payload: record(frame.payload),
  };
}

/** Only fixed public fixture labels/counts enter CI logs, never raw RPC payloads. */
export function reportQuotaStatusFailure(
  observations: unknown[],
  badge: unknown,
  report: (line: string) => void = console.error,
): void {
  try {
    const catalog = latestResponse(observations, "models.list");
    const auth = latestResponse(observations, "models.authStatus");
    const models = rows(catalog.payload.models);
    const providerModels = models.filter((model) => model.provider === "openai");
    const provider = rows(auth.payload.providers).find((item) => item.provider === "openai");
    const profile = rows(provider?.profiles).find((item) => item.profileId === "openai:quota");
    const summary = {
      badge: label(badge, ["Ready", "Signed in", "Configured", "Failed"]),
      catalog: {
        observed: catalog.observed,
        ok: catalog.ok,
        modelCount: Array.isArray(catalog.payload.models) ? models.length : null,
        openaiModelCount: Array.isArray(catalog.payload.models) ? providerModels.length : null,
        target: providerModels
          .filter((model) => model.id === "gpt-5.5")
          .slice(0, 4)
          .map((model) => ({
            available: typeof model.available === "boolean" ? model.available : null,
            unavailableReason:
              model.unavailableReason === undefined
                ? "absent"
                : label(model.unavailableReason, ["missing-auth", "auth-failed", "cooldown"]),
          })),
        outcomes: rows(catalog.payload.providerOutcomes)
          .filter((outcome) => outcome.provider === "openai")
          .slice(0, 4)
          .map((outcome) => ({
            scope:
              outcome.profileId === undefined
                ? "provider"
                : outcome.profileId === "openai:quota"
                  ? "selected-profile"
                  : "other-profile",
            status: label(outcome.status, ["ready", "auth-rejected", "unavailable"]),
          })),
        pendingOpenai: Array.isArray(catalog.payload.pendingProviders)
          ? catalog.payload.pendingProviders.includes("openai")
          : null,
      },
      auth: {
        observed: auth.observed,
        ok: auth.ok,
        providerStatus: label(provider?.status, ["ok", "expiring", "expired", "missing"]),
        profileStatus: label(profile?.status, ["ok", "expiring", "expired", "missing"]),
      },
    };
    report(`[quota-status-failure] ${JSON.stringify(summary)}`);
  } catch {
    // Reporting must never replace the original readiness assertion failure.
  }
}
