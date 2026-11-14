import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const CLAWHUB_RECOMMENDATION_LIMIT = 3;
export const CLAWHUB_RECOMMENDATIONS_CHANNEL_DATA_KEY = "openclawClawHubRecommendations";

/**
 * Gateway-authored catalog identity and install facts; models supply only a search query or an
 * exact plugin package name. Search yields official entries; an exactly named plugin may be a
 * community one, which the card presents without the official badge or direct install action.
 */
export type ClawHubRecommendation = {
  type: "clawhub";
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  installed: boolean;
} & (
  | { kind: "plugin"; official: boolean; pluginId?: string }
  | { kind: "skill"; official: true; registry: string; skillRef: string }
);

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
    typeof value.official !== "boolean"
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
  let variant:
    | { official: boolean; kind: "plugin"; pluginId?: string }
    | { official: true; kind: "skill"; registry: string; skillRef: string };
  if (value.kind === "plugin") {
    if (
      !boundedText(value.id, 512) ||
      !/^ch_[A-Za-z0-9_-]+$/.test(value.id) ||
      !optionalText(value.pluginId, 256)
    ) {
      return undefined;
    }
    variant = {
      official: value.official,
      kind: "plugin",
      ...("pluginId" in value ? { pluginId: value.pluginId } : {}),
    };
  } else {
    if (
      value.kind !== "skill" ||
      !value.official ||
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
    variant = { official: true, kind: "skill", registry, skillRef: value.id };
  }
  return {
    type: "clawhub",
    id: value.id,
    name: value.name,
    ...("description" in value ? { description: value.description } : {}),
    ...("iconUrl" in value ? { iconUrl } : {}),
    installed: value.installed,
    ...variant,
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
