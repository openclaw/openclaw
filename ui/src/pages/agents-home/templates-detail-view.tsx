import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  renderPluginDetailShell as PluginDetailShell,
  PluginReadmeWell,
} from "../plugins/detail-shell.tsx";
import { PluginInstallAction } from "../plugins/install-action.tsx";
import {
  renderPackageMetadata,
  renderPluginCapabilitySection,
  renderPublisherIdentity,
} from "../plugins/overview.tsx";
import { TemplateArtwork } from "./template-artwork.tsx";
import { createTemplateAutomationSummary } from "./template-automation-summary.ts";
import { TemplatePluginIcon } from "./template-plugin-icon.tsx";
import type { TemplateCatalogDetail, TemplateCatalogEntry } from "./templates-catalog-client.ts";
import "../../styles/sidebar-markdown.css";
import "../../styles/templates-catalog.css";
import type { TemplatesCatalogViewProps } from "./templates-catalog-view-props.ts";

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
          <strong>{title}</strong>
          <p>{audit.overview}</p>
          {detailsUrl ? (
            <a href={detailsUrl} target="_blank" rel="noopener noreferrer">
              {t("templatesTrustWarning.details")}
            </a>
          ) : undefined}
        </>
      ) : (
        <span>{warning}</span>
      )}
    </InlineAlert>
  );
}

type SoulRead =
  | { state: "loading" }
  | { state: "ready"; html: string }
  | { state: "error"; message: string };

/** The excerpt previews the soul; Show more reads the whole SOUL.md, formatted. */
function TemplatePersonality(props: {
  view: TemplatesCatalogViewProps;
  name: string;
  excerpt: string;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [read, setRead] = createSignal<SoulRead>();
  // Only the latest read may settle; a keyed parent remounts this for another release.
  let attempt = 0;
  const load = () => {
    const reader = props.view.readInstruction;
    if (!reader) {
      return;
    }
    const current = ++attempt;
    setRead({ state: "loading" });
    reader(props.name).then(
      (text) => {
        if (current === attempt) {
          setRead({
            state: "ready",
            html: toSanitizedMarkdownHtml(text, { mode: "document", remoteImages: false }),
          });
        }
      },
      (error: unknown) => {
        if (current === attempt) {
          setRead({
            state: "error",
            message: formatUiError(error, t("templatesCatalog.unavailable")),
          });
        }
      },
    );
  };
  const value = () => (expanded() ? read() : undefined);
  const ready = () => {
    const current = value();
    return current?.state === "ready" ? current : undefined;
  };
  const failure = () => {
    const current = value();
    return current?.state === "error" ? current : undefined;
  };
  return (
    <PluginReadmeWell
      alwaysExpandable={Boolean(props.view.readInstruction)}
      onToggle={(open) => {
        setExpanded(open);
        if (open && (!read() || read()?.state === "error")) {
          load();
        }
      }}
    >
      <Show
        when={ready()}
        fallback={
          <>
            <p class="templates-personality__text">{props.excerpt}</p>
            <Show when={value()?.state === "loading"}>
              <p class="templates-personality__status" role="status">
                {t("common.loading")}
              </p>
            </Show>
            <Show when={failure()}>
              {(current) => (
                <p class="templates-personality__status" role="alert">
                  {current().message}
                  <button type="button" class="btn btn--sm" onClick={load}>
                    {t("templatesCatalog.retry")}
                  </button>
                </p>
              )}
            </Show>
          </>
        }
      >
        {(current) => (
          <article class="templates-personality__markdown sidebar-markdown">
            <SanitizedHtml
              html={current().html}
              class="lit-content"
              style={{ display: "contents" }}
            />
          </article>
        )}
      </Show>
    </PluginReadmeWell>
  );
}

function TemplateContents(props: { view: TemplatesCatalogViewProps }) {
  const contents = () => props.view.readDetail()!.contents;
  const automationSummary = createTemplateAutomationSummary();
  // SOUL.md reads as the Template's personality; the page lists no other workspace files.
  const soul = createMemo(() =>
    contents().instructions.find((file) => file.name === "SOUL.md" && file.excerpt),
  );
  return (
    <>
      <Show when={soul()} keyed>
        {(file) => (
          <section class="plugin-catalog-detail__readme-section templates-personality">
            <div class="templates-personality__label">
              <h2 class="settings-section__heading oc-settings-section-title">
                {t("templatesCatalog.personality")}
              </h2>
              <button
                type="button"
                class="templates-personality__file"
                onClick={() => props.view.onOpenPreview("instruction", file.name)}
              >
                {file.name}
              </button>
            </div>
            <TemplatePersonality view={props.view} name={file.name} excerpt={file.excerpt ?? ""} />
          </section>
        )}
      </Show>
      {renderPluginCapabilitySection(
        t("templatesCatalog.skillsSection"),
        contents().skills.map((item) => ({
          name: item.name,
          description: item.excerpt,
          onOpen: () => props.view.onOpenPreview("skill", item.name),
        })),
        () => (
          <Icon name="sparkles" />
        ),
      )}
      {renderPluginCapabilitySection(
        t("templatesCatalog.integrations"),
        contents().integrations.map((item) => ({
          name:
            item.kind === "plugin"
              ? (props.view.pluginPresentation?.[item.name]?.name ?? item.name)
              : item.name,
          icon:
            item.kind === "plugin"
              ? () => <TemplatePluginIcon plugin={props.view.pluginPresentation?.[item.name]} />
              : undefined,
          description: item.kind === "plugin" ? undefined : t("tabs.mcp"),
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
          description: automationSummary(item),
          // The prompt opens in place under its row.
          details: <p class="template-automation-message">{item.message}</p>,
        })),
        () => (
          <Icon name="clock" />
        ),
      )}
    </>
  );
}

/** The plugin page's rail; the catalog entry fills what it knows until the release arrives. */
function TemplateMetadata(props: {
  entry: TemplateCatalogEntry;
  detail?: TemplateCatalogDetail | null;
  loading?: boolean;
}) {
  return (
    <>
      {renderPackageMetadata({
        loading: props.loading,
        security: props.detail?.security,
        version: props.detail?.version ?? props.entry.latestVersion,
        updatedAt: props.entry.updatedAtMs,
        createdAt: props.detail?.createdAtMs,
        downloads: props.entry.downloads,
        categories: props.detail?.categories,
        rail: { links: undefined },
      })}
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
                rail
                identity={renderPublisherIdentity({
                  // The handle names the publisher; a display name only when it says more.
                  name: publisher().ownerHandle === "openclaw" ? "OpenClaw" : undefined,
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
                sidebar={
                  <For each={[view().detailRequest]}>
                    {() => (
                      <Errored fallback={() => <TemplateMetadata entry={selected()} />}>
                        <Loading fallback={<TemplateMetadata entry={selected()} loading />}>
                          <TemplateMetadata entry={selected()} detail={view().readDetail()} />
                        </Loading>
                      </Errored>
                    )}
                  </For>
                }
                panel={
                  <>
                    <TemplateAddFeedback view={view()} />
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
                                <div class="skeleton-title skeleton" />
                                <For each={[0, 1, 2, 3]}>{() => <div class="skeleton" />}</For>
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
        <section class="templates-add-consent stack" aria-label={t("templatesCatalog.trustReview")}>
          {renderTemplateTrustWarning(props.view.consentWarning!)}
          <div class="template-actions templates-add-consent__actions">
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
