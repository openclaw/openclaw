import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { DEFAULT_CONTEXT_TOKENS, resolveDefaultModelMaxTokens } from "../agents/defaults.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/legacy-output-cap";
// Output caps that onboarding used to save into model rows: 4096 from the custom-provider
// wizard, 8192 from self-hosted setup and the former generic fallback.
const LEGACY_SAVED_OUTPUT_CAPS = new Set([4096, 8192]);
// Mistral keeps 8192 on purpose: it rejects caps that fill the context window.
const PROVIDERS_WITH_INTENTIONAL_CAPS = new Set(["mistral"]);
const MAX_LISTED_MODELS = 5;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The cap OpenClaw would invent for this row if its saved maxTokens were removed. */
function defaultCapWithoutSavedValue(model: Record<string, unknown>): number {
  const window = positiveNumber(model.contextWindow) ?? DEFAULT_CONTEXT_TOKENS;
  const served = positiveNumber(model.contextTokens) ?? window;
  return resolveDefaultModelMaxTokens(Math.min(served, window));
}

/**
 * Explains the raised default output cap to users whose config still pins an old
 * onboarding default. Notice only: a saved maxTokens may be deliberate, so Doctor
 * never rewrites it.
 */
export const legacyOutputCapCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "Saved model output caps that match a former onboarding default are reported.",
  source: "doctor",
  async detect(ctx) {
    const findings: HealthFinding[] = [];
    const providers = asNullableRecord(asNullableRecord(ctx.cfg.models)?.providers) ?? {};
    for (const [providerId, rawProvider] of Object.entries(providers)) {
      const provider = asNullableRecord(rawProvider);
      if (!provider || PROVIDERS_WITH_INTENTIONAL_CAPS.has(normalizeProviderId(providerId))) {
        continue;
      }
      // A provider-level cap replaces the default for every row, so removing a row cap
      // would not raise anything.
      if (positiveNumber(provider.maxTokens) !== undefined) {
        continue;
      }
      const models = Array.isArray(provider.models) ? provider.models : [];
      const pinned: Array<{ id: string; saved: number; next: number }> = [];
      for (const rawModel of models) {
        const model = asNullableRecord(rawModel);
        const saved = positiveNumber(model?.maxTokens);
        if (!model || saved === undefined || !LEGACY_SAVED_OUTPUT_CAPS.has(saved)) {
          continue;
        }
        const next = defaultCapWithoutSavedValue(model);
        if (next <= saved) {
          continue;
        }
        const id = typeof model.id === "string" && model.id.trim() ? model.id.trim() : "?";
        pinned.push({ id: sanitizeTerminalText(id), saved, next });
      }
      if (pinned.length === 0) {
        continue;
      }
      const displayProvider = sanitizeTerminalText(providerId);
      const path = sanitizeTerminalText(
        appendConfigPathSegment(appendConfigPathSegment("models.providers", providerId), "models"),
      );
      const listed = pinned
        .slice(0, MAX_LISTED_MODELS)
        .map(({ id, saved }) => `${id} (${saved})`)
        .join(", ");
      const more =
        pinned.length > MAX_LISTED_MODELS ? ` and ${pinned.length - MAX_LISTED_MODELS} more` : "";
      const next = Math.max(...pinned.map((entry) => entry.next));
      findings.push({
        checkId: CHECK_ID,
        severity: "info",
        source: "doctor",
        target: displayProvider,
        path,
        message:
          `Provider "${displayProvider}" pins maxTokens to a former onboarding default on ${listed}${more}. ` +
          `OpenClaw's default output cap for models without a known limit is now up to ${next} tokens, ` +
          "so these rows stay capped lower than new setups.",
        fixHint:
          "If you did not choose these values, remove maxTokens from those model rows to use the provider catalog limit or the new default. Keep them if your server needs the lower cap.",
        docsUrl: "https://docs.openclaw.ai/concepts/model-providers/custom-providers",
      });
    }
    return findings;
  },
};
