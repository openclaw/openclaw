import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const CLAWHUB_RECOMMENDATION_LIMIT = 3;
export const CLAWHUB_RECOMMENDATIONS_CHANNEL_DATA_KEY = "openclawClawHubRecommendations";

type RecommendationFields = {
  type: "clawhub";
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  installed: boolean;
  official: true;
};
/** Gateway-authored catalog identity and install facts; models supply only a search query. */
export type ClawHubRecommendation = RecommendationFields &
  ({ kind: "plugin"; pluginId?: string } | { kind: "skill"; registry: string; skillRef: string });

const sharedKeys = [
  "type",
  "id",
  "name",
  "description",
  "iconUrl",
  "installed",
  "official",
  "kind",
];
const pluginKeys = new Set([...sharedKeys, "pluginId"]);
const skillKeys = new Set([...sharedKeys, "registry", "skillRef"]);
const skillReference =
  /^@[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function boundedText(value: unknown, max: number, min = 0): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    (value.length <= max || Array.from(value).length <= max)
  );
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || boundedText(value, max);
}

function readUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  // Match the wire reader's URL normalization before applying its length limit.
  const normalized = value.trim().replace(/[\t\n\r]/g, "");
  return URL.canParse(normalized) && boundedText(normalized, 2048) ? normalized : undefined;
}

export function readClawHubRecommendation(value: unknown): ClawHubRecommendation | undefined {
  if (
    !isRecord(value) ||
    value.type !== "clawhub" ||
    !boundedText(value.name, 120, 1) ||
    !optionalText(value.description, 240) ||
    typeof value.installed !== "boolean" ||
    value.official !== true
  ) {
    return undefined;
  }
  const iconUrl = value.iconUrl === undefined ? undefined : readUrl(value.iconUrl);
  if (value.iconUrl !== undefined && iconUrl === undefined) {
    return undefined;
  }
  const allowed = value.kind === "plugin" ? pluginKeys : skillKeys;
  for (const key in value) {
    if (!allowed.has(key)) {
      return undefined;
    }
  }
  if (value.kind === "plugin") {
    if (
      !boundedText(value.id, 512) ||
      !/^ch_[A-Za-z0-9_-]+$/.test(value.id) ||
      !optionalText(value.pluginId, 256)
    ) {
      return undefined;
    }
    return {
      type: "clawhub",
      id: value.id,
      name: value.name,
      ...("description" in value ? { description: value.description } : {}),
      ...("iconUrl" in value ? { iconUrl } : {}),
      installed: value.installed,
      official: true,
      kind: "plugin",
      ...("pluginId" in value ? { pluginId: value.pluginId } : {}),
    };
  }
  if (
    value.kind !== "skill" ||
    !boundedText(value.id, 256) ||
    !skillReference.test(value.id) ||
    value.skillRef !== value.id
  ) {
    return undefined;
  }
  const registry = readUrl(value.registry);
  if (registry === undefined) {
    return undefined;
  }
  return {
    type: "clawhub",
    id: value.id,
    name: value.name,
    ...("description" in value ? { description: value.description } : {}),
    ...("iconUrl" in value ? { iconUrl } : {}),
    installed: value.installed,
    official: true,
    kind: "skill",
    registry,
    skillRef: value.id,
  };
}

export function readClawHubRecommendations(
  channelData: Record<string, unknown> | undefined,
): ClawHubRecommendation[] {
  const value = channelData?.[CLAWHUB_RECOMMENDATIONS_CHANNEL_DATA_KEY];
  if (!Array.isArray(value) || value.length > CLAWHUB_RECOMMENDATION_LIMIT) {
    return [];
  }
  const recommendations: ClawHubRecommendation[] = [];
  for (const entry of value) {
    const recommendation = readClawHubRecommendation(entry);
    if (!recommendation) {
      return [];
    }
    recommendations.push(recommendation);
  }
  return recommendations;
}
