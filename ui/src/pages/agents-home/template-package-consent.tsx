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

export function templatePackageConsents(plan: TemplateAddReviewPlan) {
  return [
    ...plan.pluginReviews
      .filter((item) => item.ownerAction === "install")
      .map((item) => ({
        kind: "plugin" as const,
        actionId: item.actionId,
        packageRef: "path" in item ? item.path : item.ref,
        label:
          ("path" in item ? item.path : item.ref) +
          " · " +
          ("path" in item
            ? t("templatesCatalog.dependencyBundled")
            : t("templatesCatalog.version", { version: item.version })),
        grants: [
          ...grantSummary(item.capabilityGrants),
          ...Object.entries(item.capabilityGrantsByPluginId)
            .filter(([id]) => id !== item.pluginId)
            .flatMap(([id, grants]) => grantSummary(grants).map((grant) => id + ": " + grant)),
        ],
        warning: item.riskWarning,
      })),
    ...plan.skillReviews.map((item) => ({
      kind: "skill" as const,
      actionId: item.actionId,
      packageRef: "path" in item ? item.path : item.ref,
      label:
        ("path" in item ? item.path : item.ref) +
        " · " +
        ("path" in item
          ? t("templatesCatalog.dependencyBundled")
          : t("templatesCatalog.version", { version: item.version })),
      grants: [],
      warning: item.riskWarning,
    })),
  ];
}

export function TemplatePackageConsent(props: {
  review: ReturnType<typeof templatePackageConsents>[number];
}) {
  return (
    <>
      <Show when={props.review.grants.length}>
        <div class="template-creator__detail-group">
          <h3>{t("pluginConsent.grantsTitle")}</h3>
          <div class="template-creator__detail-panel">
            <ul>
              <For each={props.review.grants}>{(grant) => <li>{grant}</li>}</For>
            </ul>
          </div>
        </div>
      </Show>
      <Show when={props.review.warning}>
        <InlineAlert tone="warning">{props.review.warning}</InlineAlert>
      </Show>
    </>
  );
}
