import { For, Show } from "solid-js";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { registerPluginConsentEnglish } from "../../i18n/locales/en-plugin-consent.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";
registerEnglishCatalog(registerPluginConsentEnglish);

type TemplatePluginGrants = TemplateAddReviewPlan["pluginReviews"][number]["capabilityGrants"];

function grantSummary(grants: TemplatePluginGrants): string[] {
  const status = (enabled: boolean) =>
    t(enabled ? "pluginConsent.allowed" : "pluginConsent.blocked");
  const summary = [
    `${t("pluginConsent.promptInjection")}: ${status(grants.hooks.allowPromptInjection.effective)}`,
    `${t("pluginConsent.conversationAccess")}: ${status(grants.hooks.allowConversationAccess.effective)}`,
  ];
  if (grants.llm?.allowModelOverride !== undefined) {
    summary.push(
      `${t("pluginConsent.modelOverrides")}: ${t("pluginConsent.modelOverride", { value: status(grants.llm.allowModelOverride) })}`,
    );
  }
  if (grants.llm?.allowedModels?.length) {
    summary.push(t("pluginConsent.allowedModels", { models: grants.llm.allowedModels.join(", ") }));
  }
  if (grants.llm?.allowedCompletionModels?.length) {
    summary.push(
      t("pluginConsent.allowedCompletionModels", {
        models: grants.llm.allowedCompletionModels.join(", "),
      }),
    );
  }
  if (grants.llm?.allowAuthProfileOverride !== undefined) {
    summary.push(
      t("pluginConsent.authProfileOverride", {
        value: status(grants.llm.allowAuthProfileOverride),
      }),
    );
  }
  if (grants.llm?.allowAgentIdOverride !== undefined) {
    summary.push(
      t("pluginConsent.agentIdOverride", { value: status(grants.llm.allowAgentIdOverride) }),
    );
  }
  if (grants.subagent?.allowModelOverride !== undefined) {
    summary.push(
      `${t("pluginConsent.subagentModelOverrides")}: ${t("pluginConsent.modelOverride", { value: status(grants.subagent.allowModelOverride) })}`,
    );
  }
  if (grants.subagent?.allowedModels?.length) {
    summary.push(
      `${t("pluginConsent.subagentModelOverrides")}: ${t("pluginConsent.allowedModels", { models: grants.subagent.allowedModels.join(", ") })}`,
    );
  }
  return summary;
}

export function TemplatePackageConsent(props: { plan: TemplateAddReviewPlan }) {
  return (
    <>
      <For each={props.plan.pluginReviews.filter((item) => item.ownerAction === "install")}>
        {(item) => (
          <div class="templates-add-consent__item">
            <strong>{"path" in item ? item.path : item.ref}</strong>
            <span>
              {"path" in item
                ? t("templatesCatalog.dependencyBundled")
                : t("templatesCatalog.version", { version: item.version })}
            </span>
            <strong>{t("pluginConsent.grantsTitle")}</strong>
            <ul>
              <For each={grantSummary(item.capabilityGrants)}>{(grant) => <li>{grant}</li>}</For>
            </ul>
            <For
              each={Object.entries(item.capabilityGrantsByPluginId).filter(
                ([id]) => id !== item.pluginId,
              )}
            >
              {([id, grants]) => (
                <>
                  <strong>{id}</strong>
                  <ul>
                    <For each={grantSummary(grants)}>{(grant) => <li>{grant}</li>}</For>
                  </ul>
                </>
              )}
            </For>
            <Show when={item.riskWarning}>
              {<InlineAlert tone="warning">{item.riskWarning}</InlineAlert>}
            </Show>
          </div>
        )}
      </For>
      <For each={props.plan.skillReviews}>
        {(item) => (
          <div class="templates-add-consent__item">
            <strong>{"path" in item ? item.path : item.ref}</strong>
            <span>
              {"path" in item
                ? t("templatesCatalog.dependencyBundled")
                : t("templatesCatalog.version", { version: item.version })}
            </span>
            {<InlineAlert tone="warning">{item.riskWarning}</InlineAlert>}
          </div>
        )}
      </For>
    </>
  );
}
