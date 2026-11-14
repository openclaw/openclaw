import { Errored, For, Loading, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { renderPluginDetailShell as PluginDetailShell } from "../plugins/detail-shell.tsx";
import { PluginInstallAction } from "../plugins/install-action.tsx";
import { renderPluginCapabilitySection, renderPublisherIdentity } from "../plugins/overview.tsx";
import { TemplateArtwork } from "./template-artwork.tsx";
import "../../styles/templates-catalog.css";
import type { TemplatesCatalogViewProps } from "./templates-catalog-view-props.ts";
import { TemplateWorkspaceFiles } from "./templates-workspace-files.tsx";

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
    <InlineAlert tone="warning" class="templates-trust-warning" role="alert">
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
    </InlineAlert>
  );
}

function TemplateContents(props: { view: TemplatesCatalogViewProps }) {
  const contents = () => props.view.readDetail()!.contents;
  return (
    <>
      <TemplateWorkspaceFiles
        files={contents().instructions}
        onOpen={(name) =>
          props.view.onOpenPreview("instruction", name ?? contents().instructions[0]!.name)
        }
      />
      {renderPluginCapabilitySection(
        t("templatesCatalog.skillsSection"),
        contents().skills.map((item) => ({
          name: item.name,
          description: item.excerpt,
          trailing: (
            <span class="muted">
              {item.source === "bundled"
                ? t("templatesCatalog.dependencyBundled")
                : t("templatesCatalog.dependencyClawHub", { version: item.version })}
            </span>
          ),
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
              ? item.source === "bundled"
                ? t("templatesCatalog.dependencyBundled")
                : t("templatesCatalog.dependencyClawHub", { version: item.version })
              : t("tabs.mcp"),
          trailing:
            item.kind === "plugin" &&
            item.source === "clawhub" &&
            props.view.installedPluginPackages.has(`${item.ref}@${item.version}`) ? (
              <span class="plugin-connection-status" role="status">
                <Icon name="check" /> {t("templatesCatalog.installed")}
              </span>
            ) : undefined,
          details: (
            <p>
              {item.kind === "plugin" ? t("tabs.plugin") : t("tabs.mcp")}
              {item.kind === "plugin" && item.source === "clawhub" ? ` · ${item.version}` : ""}
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
          description: `${item.schedule} · ${item.timezone} · ${t(item.enabled ? "templatesCatalog.automationEnabled" : "templatesCatalog.automationPaused")}`,
          details: (
            <p>
              {item.schedule} · {item.timezone}
              {" · "}
              {t(
                item.enabled
                  ? "templatesCatalog.automationEnabled"
                  : "templatesCatalog.automationPaused",
              )}
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

export function TemplatesDetailView(props: { view: TemplatesCatalogViewProps }) {
  return (
    <openclaw-templates-detail-view>
      <Show when={props.view.selected}>
        {(selected) => {
          const view = () => props.view!;
          const detail = () => view().detail;
          const publisher = () => detail() ?? selected();
          const canAdd = () =>
            view().canAdd && Boolean(detail()) && !view().applying && !view().consentWarning;
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
                            <InlineAlert tone="danger" role="alert">
                              {formatUiError(error())}
                              <button
                                type="button"
                                class="btn btn--sm"
                                onClick={() => view().onRetryDetail()}
                              >
                                {t("templatesCatalog.retry")}
                              </button>
                            </InlineAlert>
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
                    <TemplateAddFeedback view={view()} />
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

export function TemplateAddFeedback(props: { view: TemplatesCatalogViewProps }) {
  const failure = () =>
    props.view.addFailure?.entry.packageName === props.view.selected?.packageName
      ? props.view.addFailure?.message
      : undefined;
  return (
    <>
      <Show when={failure()}>
        <InlineAlert tone="danger" role="alert">
          {failure()}
        </InlineAlert>
      </Show>
      <Show when={props.view.consentWarning}>
        <section class="templates-add-consent" aria-label={t("templatesCatalog.trustReview")}>
          {renderTemplateTrustWarning(props.view.consentWarning!)}
          <div class="templates-add-consent__actions">
            <button type="button" class="btn" onClick={() => props.view.onCancelConsent()}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              class="btn primary"
              disabled={props.view.applying}
              onClick={() => void props.view.onConfirmConsent()}
            >
              {t("templatesCatalog.addAnyway")}
            </button>
          </div>
        </section>
      </Show>
    </>
  );
}
