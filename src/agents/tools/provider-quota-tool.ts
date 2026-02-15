import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import { readStringParam } from "./common.js";

const ProviderQuotaToolSchema = Type.Object({
  provider: Type.Optional(
    Type.String({ description: "Filter to a specific provider (e.g. 'anthropic')." }),
  ),
});

export function createProviderQuotaTool(): AnyAgentTool {
  return {
    label: "Provider Quota",
    name: "provider_quota",
    description:
      "Returns structured JSON with provider-level rate-limit / quota usage data. Use this to check remaining capacity, decide whether to throttle, or pick an alternative model/provider.",
    parameters: ProviderQuotaToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const providerFilter = readStringParam(params, "provider")?.trim().toLowerCase() as
        | UsageProviderId
        | undefined;

      const summary = await loadProviderUsageSummary({
        timeoutMs: 5000,
        providers: providerFilter ? [providerFilter] : undefined,
      });

      const providers = summary.providers.map((snap) => ({
        provider: snap.provider,
        displayName: snap.displayName,
        ...(snap.plan ? { plan: snap.plan } : {}),
        windows: snap.windows.map((w) => ({
          label: w.label,
          usedPercent: w.usedPercent,
          remainingPercent: Math.max(0, 100 - w.usedPercent),
          ...(w.resetAt ? { resetsAt: new Date(w.resetAt).toISOString() } : {}),
        })),
        error: snap.error ?? null,
      }));

      const result = {
        providers,
        updatedAt: new Date(summary.updatedAt).toISOString(),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
