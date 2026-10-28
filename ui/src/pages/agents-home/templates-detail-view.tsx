import { Errored, For, Loading, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { t } from "../../i18n/index.ts";
import { registerPluginConsentEnglish } from "../../i18n/locales/en-plugin-consent.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { renderPluginDetailShell as PluginDetailShell } from "../plugins/detail-shell.tsx";
import { PluginInstallAction } from "../plugins/install-action.tsx";
import { renderPluginCapabilitySection, renderPublisherIdentity } from "../plugins/overview.tsx";
import { TemplateArtwork } from "./template-artwork.tsx";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";
import type { TemplatesCatalogViewProps } from "./templates-catalog-view-props.ts";
import "../../styles/templates-trust-warning.css";
import { TemplateWorkspaceFiles } from "./templates-workspace-files.tsx";

registerEnglishCatalog(registerPluginConsentEnglish);

type ClawHubAudit = {
  release: string;
  outcome: string;
  overview: string;
  details: string;
};

function parseClawHubAudit(warning: string): ClawHubAudit | null {
  const lines = warning.trim().split(/\r?\n/u);
  if (
    !/^╭─ ClawHub Security Audit ─+╮$/u.test(lines[0] ?? "") ||
    !/^╰─+╯$/u.test(lines.at(-1) ?? "")
  ) {
    return null;
  }
  const body = lines.slice(1, -1).map((line) => /^│ (.*) │$/u.exec(line)?.[1]?.trim() ?? null);
  if (body.some((line) => line === null)) {
    return null;
  }
  const content = body.filter((line): line is string => Boolean(line));
  const release = content[0];
  const outcome = content[1]?.match(/^Outcome: (.+)$/u)?.[1];
  const overviewHeading = content[2];
  const wrappedDetails = content.at(-2) === "Details:";
  const details = wrappedDetails ? content.at(-1) : content.at(-1)?.match(/^Details: (.+)$/u)?.[1];
  const overview = content.slice(3, wrappedDetails ? -2 : -1).join(" ");
  if (!release || !outcome || overviewHeading !== "Overview:" || !overview || !details) {
    return null;
  }
  return { release, outcome, overview, details };
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderTemplateTrustWarning(warning: string) {
  const audit = parseClawHubAudit(warning);
  const detailsUrl = audit ? httpUrl(audit.details) : null;
  const title =
    audit?.outcome.toLowerCase() === "review"
      ? t("templatesTrustWarning.reviewRequired")
      : audit
        ? `${t("templatesTrustWarning.title")}: ${audit.outcome}`
        : "";
  return (
    <div class="callout warn templates-trust-warning" role="alert">
      {audit ? (
        <>
          <strong class="templates-trust-warning__title">{title}</strong>
          <p>{audit.overview}</p>
          {detailsUrl ? (
            <a href={detailsUrl} target="_blank" rel="noopener noreferrer">
              {t("templatesTrustWarning.details")}
            </a>
          ) : undefined}
        </>
      ) : (
        <span class="templates-trust-warning__plain">{warning}</span>
      )}
    </div>
  );
}

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

function TemplateContents(props: { view: TemplatesCatalogViewProps }) {
  const contents = () => props.view.readDetail()!.contents;
  return (
    <>
      <TemplateWorkspaceFiles
        files={contents().instructions}
        onOpen={(name) => props.view.onOpenPreview("instruction", name)}
      />
      {renderPluginCapabilitySection(
        t("templatesCatalog.skillsSection"),
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
        t("templatesCatalog.integrations"),
        contents().integrations.map((item) => ({
          name: item.name,
          description:
            item.kind === "plugin"
              ? t("templatesCatalog.version", { version: item.version ?? "" })
              : t("tabs.mcp"),
          trailing:
            item.kind === "plugin" && props.view.installedPluginPackages.has(item.name) ? (
              <span class="plugin-connection-status" role="status">
                <Icon name="check" /> {t("templatesCatalog.installed")}
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
        t("templatesCatalog.automations"),
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

function ReviewWarning(props: { view: TemplatesCatalogViewProps }) {
  return (
    <Show when={props.view.reviewPlan}>
      <section class="templates-add-consent" aria-label={t("templatesCatalog.reviewTitle")}>
        <h3>{t("templatesCatalog.reviewTitle")}</h3>
        <p>{t("templatesCatalog.reviewDescription")}</p>
        <For
          each={props.view.reviewPlan?.pluginReviews.filter(
            (item) => item.ownerAction === "install",
          )}
        >
          {(item) => (
            <div class="templates-add-consent__item">
              <strong>{item.ref}</strong>
              <span>{t("templatesCatalog.version", { version: item.version })}</span>
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
              <Show when={item.riskWarning}>{renderTemplateTrustWarning(item.riskWarning!)}</Show>
            </div>
          )}
        </For>
        <For each={props.view.reviewPlan?.skillReviews}>
          {(item) => (
            <div class="templates-add-consent__item">
              <strong>{item.ref}</strong>
              <span>{t("templatesCatalog.version", { version: item.version })}</span>
              {renderTemplateTrustWarning(item.riskWarning)}
            </div>
          )}
        </For>
        <div class="templates-add-consent__actions">
          <button type="button" class="btn" onClick={() => props.view.onCancelReview()}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={props.view.applying}
            onClick={() => void props.view.onConfirmReview()}
          >
            {t("templatesCatalog.addAnyway")}
          </button>
        </div>
      </section>
    </Show>
  );
}

export function TemplatesDetailView(props: { view: TemplatesCatalogViewProps }) {
  return (
    <openclaw-templates-detail-view>
      <Show when={props.view.selected}>
        {(selected) => {
          const view = () => props.view!;
          const detail = () => view().detail;
          const publisher = () => detail() ?? selected();
          const canAdd = () =>
            view().canAdd &&
            Boolean(detail()) &&
            !view().applying &&
            !view().consentWarning &&
            !view().reviewPlan &&
            !view().addedAgentId;
          return (
            <SettingsPage wide carapace>
              <PluginDetailShell
                id="template-catalog-detail"
                name={detail()?.agentName ?? selected().displayName}
                summary={detail()?.agentDescription ?? selected().summary}
                backHref={pathForRoute("templates", view().basePath)}
                backLabel={t("tabs.templates")}
                onBack={view().onBack}
                icon={<TemplateArtwork src={detail() ? detail()?.iconUrl : selected().iconUrl} />}
                identity={renderPublisherIdentity({
                  name:
                    publisher().ownerHandle === "openclaw" ? "OpenClaw" : publisher().ownerHandle,
                  handle: `@${publisher().ownerHandle}`,
                  official: publisher().official,
                })}
                titleAction={
                  <span data-templates-confirm>
                    <PluginInstallAction
                      buttonClass="btn oc-action plugin-catalog-detail__install"
                      primary
                      disabled={!canAdd()}
                      busy={view().applying}
                      actionLabel={t("templatesCatalog.add")}
                      busyLabel={t("templatesCatalog.adding")}
                      onInstall={() => void view().onConfirm()}
                    />
                  </span>
                }
                panel={
                  <>
                    <For each={[view().detailRequest]}>
                      {() => (
                        <Errored
                          fallback={(error) => (
                            <div class="callout danger" role="alert">
                              {formatUiError(error())}
                              <button
                                type="button"
                                class="btn btn--sm"
                                onClick={() => view().onRetryDetail()}
                              >
                                {t("templatesCatalog.retry")}
                              </button>
                            </div>
                          )}
                        >
                          <Loading
                            fallback={
                              <section
                                class="templates-content-skeleton"
                                role="status"
                                aria-label={t("templatesCatalog.contentsLoading")}
                              >
                                <div class="templates-content-skeleton__title skeleton" />
                                <For each={[0, 1, 2, 3]}>
                                  {() => <div class="templates-content-skeleton__row skeleton" />}
                                </For>
                              </section>
                            }
                          >
                            <Show when={view().readDetail()}>
                              <TemplateContents view={view()} />
                            </Show>
                          </Loading>
                        </Errored>
                      )}
                    </For>
                    <Show when={view().addError}>
                      <div class="callout danger" role="alert">
                        {view().addError}
                        <Show when={view().addedAgentId}>
                          <button
                            type="button"
                            class="btn btn--sm"
                            onClick={() => void view().onRetryOpenChat()}
                          >
                            {t("templatesCatalog.openChat")}
                          </button>
                        </Show>
                      </div>
                    </Show>
                    <Show when={!view().consentWarning}>
                      <ReviewWarning view={view()} />
                    </Show>
                    <Show when={view().consentWarning}>
                      <section
                        class="templates-add-consent"
                        aria-label={t("templatesCatalog.trustReview")}
                      >
                        {renderTemplateTrustWarning(view().consentWarning!)}
                        <div class="templates-add-consent__actions">
                          <button
                            type="button"
                            class="btn"
                            onClick={() => view().onCancelConsent()}
                          >
                            {t("common.cancel")}
                          </button>
                          <button
                            type="button"
                            class="btn primary"
                            disabled={view().applying}
                            onClick={() => void view().onConfirmConsent()}
                          >
                            {t("templatesCatalog.addAnyway")}
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
    </openclaw-templates-detail-view>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-templates-detail-view": HTMLAttributes<HTMLElement>;
    }
  }
}
