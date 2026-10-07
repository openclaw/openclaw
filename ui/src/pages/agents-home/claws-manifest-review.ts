import { html, nothing } from "lit";
import type { ClawLifecyclePlanResult } from "../../../../packages/gateway-protocol/src/schema/claws.js";
import { t } from "../../i18n/index.ts";
import "../../styles/claws-manifest-review.css";

type ManifestPlan = Pick<ClawLifecyclePlanResult, "operation" | "target" | "manifestDisclosure">;
type SourceCoordinate = { packageName: string; version: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNormalizedManifest(value: string): boolean {
  try {
    const manifest: unknown = JSON.parse(value);
    return (
      isRecord(manifest) &&
      manifest.schemaVersion === 1 &&
      isRecord(manifest.agent) &&
      typeof manifest.agent.id === "string" &&
      isRecord(manifest.workspace) &&
      Array.isArray(manifest.packages) &&
      isRecord(manifest.mcpServers) &&
      Array.isArray(manifest.cronJobs)
    );
  } catch {
    return false;
  }
}

function isNormalizedProfile(value: string): boolean {
  try {
    const profile: unknown = JSON.parse(value);
    return isRecord(profile) && profile.schemaVersion === 1 && isRecord(profile.agent);
  } catch {
    return false;
  }
}

export function hasCompleteClawManifestDisclosure(
  plan: ManifestPlan | null | undefined,
  expected?: SourceCoordinate,
): boolean {
  if (!plan || (plan.operation !== "add" && plan.operation !== "update")) {
    return false;
  }
  const disclosure = plan.manifestDisclosure;
  const source = disclosure?.source;
  return Boolean(
    source &&
    /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u.test(source.packageName) &&
    /^sha256:[a-f0-9]{64}$/u.test(source.integrity) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0 &&
    source.packageName === plan.target.name &&
    source.version === plan.target.targetVersion &&
    (!expected ||
      (source.packageName === expected.packageName && source.version === expected.version)) &&
    typeof disclosure.manifestJson === "string" &&
    isNormalizedManifest(disclosure.manifestJson) &&
    (disclosure.openClawProfileJson === undefined ||
      (typeof disclosure.openClawProfileJson === "string" &&
        isNormalizedProfile(disclosure.openClawProfileJson))),
  );
}

export function renderClawManifestReview(
  plan: ManifestPlan | null | undefined,
  expected?: SourceCoordinate,
) {
  const disclosure = plan?.manifestDisclosure;
  if (!hasCompleteClawManifestDisclosure(plan, expected) || !disclosure) {
    return html`<div class="callout danger" role="alert">
      ${t("clawsManifestReview.unavailable")}
    </div>`;
  }
  const source = disclosure.source;
  return html`<details class="claws-manifest-review" data-claws-manifest>
    <summary>
      <strong>${t("clawsManifestReview.title")}</strong>
      <span>${source.packageName}@${source.version}</span>
    </summary>
    <div class="claws-manifest-review__body">
      <div class="claws-manifest-review__source">
        <span>${t("clawsManifestReview.integrity")}</span>
        <code>${source.integrity}</code>
        <span>${t("clawsManifestReview.bytes")}</span>
        <span>${source.byteLength}</span>
      </div>
      <h4>${t("clawsManifestReview.manifest")}</h4>
      <pre><code>${disclosure.manifestJson}</code></pre>
      ${
        disclosure.openClawProfileJson
          ? html`<h4>${t("clawsManifestReview.profile")}</h4>
              <pre><code>${disclosure.openClawProfileJson}</code></pre>`
          : nothing
      }
    </div>
  </details>`;
}
