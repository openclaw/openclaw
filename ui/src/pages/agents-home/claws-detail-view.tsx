import { For, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { t } from "../../i18n/index.ts";
import { registerPluginConsentEnglish } from "../../i18n/locales/en-plugin-consent.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { renderPluginDetailShell as PluginDetailShell } from "../plugins/detail-shell.tsx";
import { PluginInstallAction } from "../plugins/install-action.tsx";
import { renderPluginCapabilitySection, renderPublisherIdentity } from "../plugins/overview.tsx";
import type { ClawAddReviewPlan } from "./claws-catalog-client.ts";
import type { ClawsCatalogViewProps } from "./claws-catalog-view-props.ts";
import { renderClawTrustWarning } from "./claws-trust-warning.tsx";
import { ClawWorkspaceFiles } from "./claws-workspace-files.tsx";

registerEnglishCatalog(registerPluginConsentEnglish);

type ClawPluginGrants = ClawAddReviewPlan["pluginReviews"][number]["capabilityGrants"];

function grantSummary(grants: ClawPluginGrants): string[] {
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

function ClawContents(props: { view: ClawsCatalogViewProps }) {
  const contents = () => props.view.detail!.contents;
  return (
    <>
      <ClawWorkspaceFiles
        files={contents().instructions}
        onOpen={(name) => props.view.onOpenPreview("instruction", name)}
      />
      {renderPluginCapabilitySection(
        t("clawsCatalog.skillsSection"),
        contents().skills.map((item) => ({
          name: item.name,
          description: item.excerpt,
          onOpen: () => props.view.onOpenPreview("skill", item.name),
        })),
        () => (
          <Icon name="book" />
        ),
      )}
      {renderPluginCapabilitySection(
        t("clawsCatalog.integrations"),
        contents().integrations.map((item) => ({
          name: item.name,
          description:
            item.kind === "plugin"
              ? t("clawsCatalog.version", { version: item.version ?? "" })
              : t("tabs.mcp"),
          trailing:
            item.kind === "plugin" && props.view.installedPluginPackages.has(item.name) ? (
              <span class="plugin-connection-status" role="status">
                <Icon name="check" /> {t("clawsCatalog.installed")}
              </span>
            ) : undefined,
          details: (
            <p>
              {item.kind === "plugin" ? t("tabs.plugin") : t("tabs.mcp")}
              {item.version ? ` · ${item.version}` : ""}
            </p>
          ),
        })),
        () => (
          <Icon name="plug" />
        ),
      )}
      {renderPluginCapabilitySection(
        t("clawsCatalog.automations"),
        contents().automations.map((item) => ({
          name: item.name,
          description: `${item.schedule} · ${item.timezone}`,
          details: (
            <p>
              {item.schedule} · {item.timezone}
            </p>
          ),
        })),
        () => (
          <Icon name="clock" />
        ),
      )}
    </>
  );
}

function ReviewWarning(props: { view: ClawsCatalogViewProps }) {
  return (
    <Show when={props.view.reviewPlan}>
      <section class="claws-add-consent" aria-label={t("clawsCatalog.reviewTitle")}>
        <h3>{t("clawsCatalog.reviewTitle")}</h3>
        <p>{t("clawsCatalog.reviewDescription")}</p>
        <For
          each={props.view.reviewPlan?.pluginReviews.filter(
            (item) => item.ownerAction === "install",
          )}
        >
          {(item) => (
            <div class="claws-add-consent__item">
              <strong>{item.ref}</strong>
              <span>{t("clawsCatalog.version", { version: item.version })}</span>
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
              <Show when={item.riskWarning}>{renderClawTrustWarning(item.riskWarning!)}</Show>
            </div>
          )}
        </For>
        <For each={props.view.reviewPlan?.skillReviews}>
          {(item) => (
            <div class="claws-add-consent__item">
              <strong>{item.ref}</strong>
              <span>{t("clawsCatalog.version", { version: item.version })}</span>
              {renderClawTrustWarning(item.riskWarning)}
            </div>
          )}
        </For>
        <div class="claws-add-consent__actions">
          <button type="button" class="btn" onClick={() => props.view.onCancelReview()}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={props.view.applying}
            onClick={() => props.view.onConfirmReview()}
          >
            {t("clawsCatalog.addAnyway")}
          </button>
        </div>
      </section>
    </Show>
  );
}

export function ClawsDetailView(props: { view: ClawsCatalogViewProps }) {
  return (
    <openclaw-claws-detail-view>
      <Show when={props.view.selected}>
        {(selected) => {
          const view = () => props.view!;
          const detail = () => view().detail;
          const publisher = () => detail() ?? selected();
          const canAdd = () =>
            view().canAdd &&
            Boolean(detail()) &&
            !view().detailLoading &&
            !view().applying &&
            !view().consentWarning &&
            !view().reviewPlan &&
            !view().addedAgentId;
          return (
            <SettingsPage wide carapace>
              <PluginDetailShell
                id="claw-catalog-detail"
                name={detail()?.agentName ?? selected().displayName}
                summary={detail()?.agentDescription ?? selected().summary}
                backHref={pathForRoute("agents-home", view().basePath)}
                backLabel="Agents"
                onBack={view().onBack}
                icon={<Icon name="box" />}
                identity={renderPublisherIdentity({
                  name:
                    publisher().ownerHandle === "openclaw" ? "OpenClaw" : publisher().ownerHandle,
                  handle: `@${publisher().ownerHandle}`,
                  official: publisher().official,
                })}
                titleAction={
                  <span data-claws-confirm>
                    <PluginInstallAction
                      buttonClass="btn oc-action plugin-catalog-detail__install"
                      primary
                      disabled={!canAdd()}
                      busy={view().applying}
                      actionLabel={t("clawsCatalog.add")}
                      busyLabel={t("clawsCatalog.adding")}
                      onInstall={view().onConfirm}
                    />
                  </span>
                }
                panel={
                  <>
                    <Show when={view().detailError}>
                      <div class="callout danger" role="alert">
                        {view().detailError}
                        <button type="button" class="btn btn--sm" onClick={view().onRetryDetail}>
                          {t("clawsCatalog.retry")}
                        </button>
                      </div>
                    </Show>
                    <Show when={view().detailLoading}>
                      <section
                        class="claws-content-skeleton"
                        role="status"
                        aria-label={t("clawsCatalog.contentsLoading")}
                      >
                        <div class="claws-content-skeleton__title skeleton" />
                        <For each={[0, 1, 2, 3]}>
                          {() => <div class="claws-content-skeleton__row skeleton" />}
                        </For>
                      </section>
                    </Show>
                    <Show when={detail()}>
                      <ClawContents view={view()} />
                    </Show>
                    <Show when={view().addError}>
                      <div class="callout danger" role="alert">
                        {view().addError}
                        <Show when={view().addedAgentId}>
                          <button
                            type="button"
                            class="btn btn--sm"
                            onClick={view().onRetryOpenChat}
                          >
                            {t("clawsCatalog.openChat")}
                          </button>
                        </Show>
                      </div>
                    </Show>
                    <Show when={!view().consentWarning}>
                      <ReviewWarning view={view()} />
                    </Show>
                    <Show when={view().consentWarning}>
                      <section class="claws-add-consent" aria-label={t("clawsCatalog.trustReview")}>
                        {renderClawTrustWarning(view().consentWarning!)}
                        <div class="claws-add-consent__actions">
                          <button type="button" class="btn" onClick={view().onCancelConsent}>
                            {t("common.cancel")}
                          </button>
                          <button
                            type="button"
                            class="btn primary"
                            disabled={view().applying}
                            onClick={view().onConfirmConsent}
                          >
                            {t("clawsCatalog.addAnyway")}
                          </button>
                        </div>
                      </section>
                    </Show>
                  </>
                }
              />
            </SettingsPage>
          );
        }}
      </Show>
    </openclaw-claws-detail-view>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-claws-detail-view": HTMLAttributes<HTMLElement>;
    }
  }
}
