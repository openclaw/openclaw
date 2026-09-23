// ClawHub promotion APIs and declarative payload validation.
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import {
  fetchClawHubJson,
  readClawHubBooleanField,
  readClawHubStringArrayField,
  readClawHubStringField,
  readRequiredClawHubBooleanField,
  readRequiredClawHubNumberField,
  readRequiredClawHubStringField,
  type ClawHubFetch,
} from "./clawhub-client.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";

// ─── ClawHub promotions ────────────────────────────────────────────────────
// Promotional model offers published by ClawHub (GET /api/v1/promotions).
// The payload is declarative only: provider/authChoiceId/pluginNames are
// validated against the local provider catalog by the caller before any
// install/auth action, so a malformed or hostile record cannot execute code.

type ClawHubPromotionModel = {
  modelRef: string;
  alias?: string;
  suggestedDefault?: boolean;
};

export type ClawHubPromotion = {
  slug: string;
  title: string;
  blurb: string;
  sponsor?: string;
  status: string;
  active: boolean;
  startsAt: number;
  endsAt: number;
  provider?: string;
  authChoiceId?: string;
  pluginNames?: string[];
  models: ClawHubPromotionModel[];
  signupUrl?: string;
  docsUrl?: string;
  launchPageUrl?: string;
};

type ClawHubPromotionDetails = Omit<ClawHubPromotion, "status" | "active">;

// Shell-safe contract for provider/model refs: they are echoed into
// copy-paste CLI commands, so whitespace and shell metacharacters must fail
// parsing rather than reach a terminal.
const CLAWHUB_PROMOTION_MODEL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function parseClawHubPromotionModel(value: unknown, context: string): ClawHubPromotionModel {
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected each model to be an object.`);
  }
  const modelRef = readRequiredClawHubStringField(value, "modelRef", context);
  if (!CLAWHUB_PROMOTION_MODEL_REF_RE.test(modelRef)) {
    throw new Error(`Malformed ClawHub ${context}: modelRef contains unsupported characters.`);
  }
  const model: ClawHubPromotionModel = {
    modelRef,
  };
  const alias = readClawHubStringField(value, "alias", context);
  if (alias) {
    model.alias = alias;
  }
  const suggestedDefault = readClawHubBooleanField(value, "suggestedDefault", context);
  if (suggestedDefault !== undefined) {
    model.suggestedDefault = suggestedDefault;
  }
  return model;
}

// ClawHub's server-side slug contract. Enforced here because slugs are echoed
// into copy-paste CLI commands; anything else would be a shell-injection path.
const CLAWHUB_PROMOTION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Safe identifier grammar for provider ids and auth choice ids.
const CLAWHUB_PROMOTION_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

// Validate promotion details before adding status and activation metadata.
function parseClawHubPromotionCore(
  value: Record<string, unknown>,
  context: string,
): ClawHubPromotionDetails {
  const modelsRaw = value.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error(`Malformed ClawHub ${context}: expected models to be a non-empty array.`);
  }
  const slug = readRequiredClawHubStringField(value, "slug", context);
  if (!CLAWHUB_PROMOTION_SLUG_RE.test(slug)) {
    throw new Error(`Malformed ClawHub ${context}: slug must be lowercase [a-z0-9-].`);
  }
  const startsAt = readRequiredClawHubNumberField(value, "startsAt", context);
  const endsAt = readRequiredClawHubNumberField(value, "endsAt", context);
  if (endsAt <= startsAt) {
    throw new Error(`Malformed ClawHub ${context}: promotion window must end after it starts.`);
  }
  const promotion: ClawHubPromotionDetails = {
    slug,
    title: readRequiredClawHubStringField(value, "title", context),
    blurb: readRequiredClawHubStringField(value, "blurb", context),
    startsAt,
    endsAt,
    models: modelsRaw.map((entry) => parseClawHubPromotionModel(entry, context)),
  };
  const optionalStrings = ["sponsor", "signupUrl", "docsUrl", "launchPageUrl"] as const;
  for (const field of optionalStrings) {
    const parsed = readClawHubStringField(value, field, context);
    if (parsed) {
      promotion[field] = parsed;
    }
  }
  // Identifier fields are echoed into error messages and config; hold them to
  // a safe identifier grammar so remote payloads cannot smuggle terminal
  // controls or whitespace through failure paths.
  const identifierFields = ["provider", "authChoiceId"] as const;
  for (const field of identifierFields) {
    const parsed = readClawHubStringField(value, field, context);
    if (!parsed) {
      continue;
    }
    if (!CLAWHUB_PROMOTION_IDENTIFIER_RE.test(parsed)) {
      throw new Error(`Malformed ClawHub ${context}: ${field} contains unsupported characters.`);
    }
    promotion[field] = parsed;
  }
  const pluginNames = readClawHubStringArrayField(value, "pluginNames", context);
  if (pluginNames && pluginNames.length > 0) {
    for (const name of pluginNames) {
      const parsed = parseRegistryNpmSpec(name);
      if (!parsed || parsed.selectorKind !== "none" || parsed.name !== name) {
        throw new Error(
          `Malformed ClawHub ${context}: pluginNames must contain npm package names.`,
        );
      }
    }
    promotion.pluginNames = pluginNames;
  }
  return promotion;
}

function parseClawHubPromotion(value: unknown): ClawHubPromotion {
  const context = "promotion";
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected an object.`);
  }
  return {
    ...parseClawHubPromotionCore(value, context),
    status: readRequiredClawHubStringField(value, "status", context),
    active: readRequiredClawHubBooleanField(value, "active", context),
  };
}

export async function fetchClawHubPromotions(
  params: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: ClawHubFetch;
  } = {},
): Promise<ClawHubPromotion[]> {
  const response = await fetchClawHubJson<unknown>({
    baseUrl: params.baseUrl,
    path: "/api/v1/promotions",
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!isJsonObject(response) || !Array.isArray(response.promotions)) {
    throw new Error("Malformed ClawHub promotions response: expected a promotions array.");
  }
  return response.promotions.map((entry) => parseClawHubPromotion(entry));
}

export async function fetchClawHubPromotion(params: {
  slug: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubPromotion> {
  const response = await fetchClawHubJson<unknown>({
    baseUrl: params.baseUrl,
    path: `/api/v1/promotions/${encodeURIComponent(params.slug)}`,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  return parseClawHubPromotion(response);
}
