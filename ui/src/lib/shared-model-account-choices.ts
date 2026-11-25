import { splitTrailingAuthProfile } from "../../../src/agents/model-ref-profile.js";
import type { ModelAuthStatusResult, ModelCatalogEntry } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { buildQualifiedChatModelValue } from "./chat/model-ref.ts";

/** Never use another model, runtime or usage-provider alias as a source of account choices. */
export function sharedModelAccountChoices(
  status: ModelAuthStatusResult | undefined,
  model: string,
  route: ModelCatalogEntry | undefined,
) {
  const target = status?.accountTarget;
  if (
    !target ||
    !route ||
    target.provider !== route.provider ||
    target.model !== route.id ||
    target.runtime !== (route.agentRuntime?.id ?? "openclaw") ||
    model !== buildQualifiedChatModelValue(route.id, route.provider)
  ) {
    return [];
  }
  return target.accounts
    .filter(
      ({ profileId }) => splitTrailingAuthProfile(`${model}@${profileId}`).profile === profileId,
    )
    .map((account) => ({
      profileId: account.profileId,
      displayName: account.displayName,
      email: account.email,
      label:
        account.ordinal !== undefined
          ? t("chat.modelAccounts.sharedNumber", { number: String(account.ordinal) })
          : t("chat.modelAccounts.sharedAccount"),
    }));
}
