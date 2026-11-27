import type { ModelsListResult } from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import {
  isUserModelAuthProfileId,
  parseUserModelAuthProfileId,
} from "../state/user-model-account-id.js";
import { hasGatewayAdminScope, READ_SCOPE, SESSION_WRITE_SCOPE } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";
import { projectModelFastModeCatalog } from "./session-fast-mode-presentation.js";
import { sharedModelAccountRef } from "./shared-model-account-ref.js";

/** Project only at delivery: cached catalogs and execution policy compare canonical profile IDs. */
export function projectClientModelCatalog<T extends Partial<ModelsListResult>>(
  canonical: T,
  client: GatewayClient | null,
): T {
  const payload = projectModelFastModeCatalog(canonical, client);
  if (!client || hasGatewayAdminScope(client)) {
    return payload;
  }
  const selection = payload.accountSelection;
  const utility = payload.utilityModel;
  const defaults = payload.defaultModels;
  const outcomes = payload.providerOutcomes;
  const shared = selection?.kind === "shared";
  let visibleOutcomes: typeof outcomes;
  if (outcomes) {
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.profileId && !isUserModelAuthProfileId(outcome.profileId)) {
        (visibleOutcomes ??= outcomes.slice())[index] = {
          ...outcome,
          profileId: sharedModelAccountRef(outcome.profileId),
        };
      }
    }
  }
  const publicModelRef = (ref: string | null | undefined) => {
    if (!ref) {
      return ref;
    }
    const { model, profile } = splitTrailingAuthProfile(ref);
    return profile && !isUserModelAuthProfileId(profile) ? model : ref;
  };
  const utilityRef = publicModelRef(utility?.modelRef);
  const automaticRef = publicModelRef(defaults?.automaticUtilityModel);
  if (
    !shared &&
    !visibleOutcomes &&
    utilityRef === utility?.modelRef &&
    automaticRef === defaults?.automaticUtilityModel
  ) {
    return payload;
  }
  return {
    ...payload,
    ...(shared
      ? {
          accountSelection: {
            kind: selection.kind,
            source: selection.source,
            // Session-only readers and read-only observers need no provider inventory facts.
            ...(selection.ordinal &&
            operatorScopeSatisfied(READ_SCOPE, client.connect.scopes ?? []) &&
            operatorScopeSatisfied(SESSION_WRITE_SCOPE, client.connect.scopes ?? [])
              ? { ordinal: selection.ordinal }
              : {}),
            authProfileId: sharedModelAccountRef(selection.authProfileId),
            label: "Shared account",
          },
        }
      : {}),
    ...(visibleOutcomes ? { providerOutcomes: visibleOutcomes } : {}),
    ...(utilityRef && utilityRef !== utility?.modelRef
      ? { utilityModel: { ...utility, modelRef: utilityRef } }
      : {}),
    ...(automaticRef && automaticRef !== defaults?.automaticUtilityModel
      ? { defaultModels: { ...defaults, automaticUtilityModel: automaticRef } }
      : {}),
  };
}

/** A mutation receipt is a display copy; never replace canonical IDs in saved routing state. */
export function projectSessionEntryAccounts<T extends Partial<SessionEntry>>(
  entry: T,
  viewerProfileId: string | undefined,
): T {
  const projectLocator = <K extends string, R extends Partial<Record<K, string>>>(
    row: R,
    key: K,
  ): R => {
    const id = row[key];
    if (!id) {
      return row;
    }
    const personal = parseUserModelAuthProfileId(id);
    if (!personal) {
      return { ...row, [key]: sharedModelAccountRef(id) };
    }
    if (personal.ownerProfileId === viewerProfileId) {
      return row;
    }
    const projected = { ...row };
    delete projected[key];
    return projected;
  };
  const projected = projectLocator(entry, "authProfileOverride");
  const fallback = entry.modelFallback;
  const bindings = entry.cliSessionBindings;
  if (!fallback?.prevAuthProfileOverride && !bindings) {
    return projected;
  }
  return {
    ...projected,
    ...(fallback ? { modelFallback: projectLocator(fallback, "prevAuthProfileOverride") } : {}),
    ...(bindings
      ? {
          cliSessionBindings: Object.fromEntries(
            Object.entries(bindings).map(([key, binding]) => [
              key,
              projectLocator(binding, "authProfileId"),
            ]),
          ),
        }
      : {}),
  };
}
