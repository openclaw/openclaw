import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import {
  PLUGIN_UI_CAPABILITIES,
  type PluginUiCapability,
} from "../../../../packages/gateway-protocol/src/plugin-ui-capabilities.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";
import { askBrandLabel } from "../../components/theme-brand-label.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatDateMs } from "../../lib/format.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { formatCompactCount } from "./catalog-results.tsx";
import { ExtensionIcon } from "./extension-icons.tsx";
import { renderPluginAuthor, renderPluginOfficialBadge } from "./plugin-card.tsx";
import { renderPluginRowMessage } from "./plugin-row-message.tsx";

registerEnglishCatalog(registerPluginManagementEnglish);

function securityTone(status: string): "pass" | "warning" | "danger" | "unknown" {
  if (/^(?:clean|pass|safe|benign|cleared)$/iu.test(status)) {
    return "pass";
  }
  if (/^(?:suspicious|warning|review)$/iu.test(status)) {
    return "warning";
  }
  if (/^(?:blocked|danger|fail|malicious)$/iu.test(status)) {
    return "danger";
  }
  return "unknown";
}

function renderPluginSecurityAudit(status: string, auditUrl: string | null | undefined) {
  const tone = securityTone(status);
  const bars = { pass: 3, warning: 2, danger: 1, unknown: 0 }[tone];
  return (
    <a
      class={["plugin-catalog-detail__security", `plugin-catalog-detail__security--${tone}`]}
      href={auditUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
    >
      <h2 class="settings-section__heading oc-settings-section-title">
        {t("pluginsPage.detailSecurity")}
        <span title={t("pluginsPage.detailSecurityAudit")}>{<Icon name="info" />}</span>
      </h2>
      <div class="plugin-catalog-detail__security-score">
        <strong>
          {tone === "pass"
            ? t("pluginsPage.auditClean")
            : tone === "warning"
              ? t("pluginsPage.auditReview")
              : status}
        </strong>
        <For each={[0, 1, 2]}>
          {(index) => <span class={{ "is-filled": index < bars }} aria-hidden="true" />}
        </For>
      </div>
    </a>
  );
}

export function renderPluginCompatibilityNotices(
  notices: PluginCatalogItem["compatibilityNotices"],
  showApis = false,
): JSX.Element {
  return (
    <For each={notices}>
      {(notice) =>
        renderPluginRowMessage({
          kind: "info",
          get text() {
            return notice.removalDate
              ? t("pluginsPage.compatibilityDeprecatedDated", {
                  date: formatDateMs(Date.parse(`${notice.removalDate}T00:00:00Z`), {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    timeZone: "UTC",
                  }),
                })
              : t("pluginsPage.compatibilityDeprecatedUndated");
          },
          link: notice.migrationGuideUrl
            ? {
                href: notice.migrationGuideUrl,
                get text() {
                  return t("pluginsPage.compatibilityDetails");
                },
              }
            : undefined,
          details:
            showApis && notice.apis.length ? (
              <dl class="plugin-compatibility-apis" aria-label={t("pluginsPage.compatibilityApis")}>
                <For each={notice.apis}>
                  {(api) => (
                    <div>
                      <dt>
                        <code>{api.displayName}</code>
                      </dt>
                      <dd>{api.replacement}</dd>
                    </div>
                  )}
                </For>
              </dl>
            ) : undefined,
        })
      }
    </For>
  );
}

function pluginWebUrl(value: string | undefined): URL | null {
  const url = value ? URL.parse(value) : null;
  return url && /^https?:$/u.test(url.protocol) && !url.username && !url.password ? url : null;
}

function pluginRepository(
  value: string | undefined,
): { href: string; name: string; github: boolean } | null {
  if (!value) {
    return null;
  }
  const source = /^[\w.-]+\/[\w.-]+$/u.test(value)
    ? `https://github.com/${value}`
    : value.replace(/^git\+/u, "");
  const url = pluginWebUrl(source);
  if (!url) {
    return null;
  }
  const github = url.hostname === "github.com";
  const [owner, repository] = url.pathname.split("/").filter(Boolean);
  if (github && owner && repository) {
    const name = `${owner}/${repository.replace(/\.git$/u, "")}`;
    return { href: `https://github.com/${name}`, name, github };
  }
  return { href: url.href, name: url.hostname + url.pathname.replace(/\/$/u, ""), github };
}

export function renderPublisherIdentity(options: {
  name?: string;
  handle?: string;
  official?: boolean;
}): JSX.Element | undefined {
  const { name, handle, official } = options;
  if (!name && !handle) {
    return undefined;
  }
  return (
    <div class="plugin-catalog-detail__publisher">
      <span class="plugin-catalog-detail__publisher-name">
        {name ? <strong>{name}</strong> : renderPluginAuthor(handle)}
        {official ? renderPluginOfficialBadge() : undefined}
      </span>
      {name ? renderPluginAuthor(handle) : undefined}
    </div>
  );
}

export function renderPluginPublisher(
  result: PluginDiscoveryDetailResult | undefined,
  localName?: string,
): JSX.Element | undefined {
  const author = result?.detail.author;
  return renderPublisherIdentity({
    name: author?.displayName ?? localName,
    handle: author?.handle ?? result?.plugin.catalog.author,
    official: author?.official === true,
  });
}

export function renderPluginMetadata(
  result: PluginDiscoveryDetailResult | undefined,
  installedVersion?: string,
  local?: PluginsInspectResult["overview"],
  loading = false,
): JSX.Element {
  const detail = result?.detail;
  const catalog = result?.plugin.catalog;
  const repository = pluginRepository(
    local?.repositoryUrl ?? detail?.repositoryUrl ?? detail?.verification?.sourceRepo,
  );
  const documentation = pluginWebUrl(local?.documentationUrl ?? detail?.documentationUrl);
  const values: Array<[string, string | undefined]> = [
    [
      t(installedVersion ? "pluginsPage.detailInstalledVersion" : "pluginsPage.version"),
      installedVersion ?? catalog?.latestVersion,
    ],
    [
      t("pluginsPage.detailUpdated"),
      detail?.updatedAt === undefined
        ? undefined
        : formatDateMs(detail.updatedAt, { dateStyle: "medium" }),
    ],
    [
      t("pluginsPage.detailPublished"),
      detail?.createdAt === undefined
        ? undefined
        : formatDateMs(detail.createdAt, { dateStyle: "medium" }),
    ],
    [
      t("pluginsPage.catalogDownloadsColumn"),
      catalog?.downloads === undefined ? undefined : formatCompactCount(catalog.downloads),
    ],
  ];
  const categories = catalog?.categories ?? [];
  const placeholder = () => (
    <span class="plugin-metadata__placeholder skeleton" aria-hidden="true" />
  );
  return (
    <>
      {loading ? (
        <section
          class="plugin-metadata__loading"
          role="status"
          aria-label={t("pluginsPage.detailLoading")}
        >
          <span class="plugin-metadata__placeholder skeleton" aria-hidden="true" />
          {placeholder()}
        </section>
      ) : undefined}
      {detail?.security
        ? renderPluginSecurityAudit(detail.security.verdict ?? "unknown", detail.security.auditUrl)
        : undefined}
      {loading || values.some(([, value]) => value !== undefined) ? (
        <dl class="plugin-metadata__facts">
          <For each={values.filter(([, value]) => loading || value !== undefined)}>
            {([label, value]) => (
              <div>
                <dt>{label}</dt>
                <dd>{value ?? placeholder()}</dd>
              </div>
            )}
          </For>
        </dl>
      ) : undefined}
      {categories.length ? (
        <section class="plugin-metadata__section">
          <h2 class="settings-section__heading oc-settings-section-title">
            {t("pluginsPage.detailCategories")}
          </h2>
          <div class="plugin-metadata__categories">
            <For each={categories}>{(category) => <span class="chip">{category}</span>}</For>
          </div>
        </section>
      ) : undefined}
      {repository || documentation ? (
        <ul class="plugin-metadata__links">
          {repository ? (
            <li>
              <a
                class="plugin-metadata__repository"
                href={repository.href}
                target="_blank"
                rel="noopener noreferrer"
                title={t("pluginsPage.detailRepository")}
              >
                {repository.github ? <Icon name="github" /> : <Icon name="externalLink" />}
                <span>{repository.name}</span>
              </a>
            </li>
          ) : undefined}
          {documentation ? (
            <li>
              <a href={documentation.href} target="_blank" rel="noopener noreferrer">
                <span>{t("pluginsPage.detailDocumentation")}</span>
                <Icon name="arrowUpRight" />
              </a>
            </li>
          ) : undefined}
        </ul>
      ) : undefined}
    </>
  );
}

type PluginCapabilityRow = {
  icon?: () => JSX.Element;
  name: string;
  description?: string;
  onOpen?: () => void;
  trailing?: JSX.Element;
  details?: JSX.Element;
};

function PluginCapabilityRowText(props: { value: PluginCapabilityRow }) {
  return (
    <div class="settings-row__text oc-settings-row-content">
      <span class="settings-row__title oc-settings-row-title">{props.value.name}</span>
      {props.value.description ? (
        <span class="settings-row__desc oc-settings-row-description">
          {props.value.description}
        </span>
      ) : undefined}
    </div>
  );
}

function PluginCapabilityRowControl(props: { value: PluginCapabilityRow; chevron: boolean }) {
  return props.value.trailing || props.chevron ? (
    <div class="settings-row__control oc-settings-row-control">
      {props.value.trailing}
      {props.chevron ? (
        <span class="settings-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      ) : undefined}
    </div>
  ) : undefined;
}

export function renderPluginCapabilitySection(
  title: string,
  values: PluginCapabilityRow[],
  icon?: () => JSX.Element,
): JSX.Element {
  return values.length ? (
    <div class="plugin-capabilities">
      <SettingsSection title={title} carapace>
        <For each={values}>
          {(value) => {
            const content = (chevron: boolean) => (
              <>
                <span class="plugin-capability__icon" aria-hidden="true">
                  {value.icon?.() ?? icon?.()}
                </span>
                <PluginCapabilityRowText value={value} />
                <PluginCapabilityRowControl value={value} chevron={chevron} />
              </>
            );
            return value.details ? (
              <details class="plugin-capability__disclosure">
                <summary class="settings-row settings-row--nav oc-settings-row">
                  {content(true)}
                </summary>
                <div class="plugin-capability__details">{value.details}</div>
              </details>
            ) : value.onOpen ? (
              <button
                type="button"
                class="settings-row settings-row--nav oc-settings-row"
                onClick={value.onOpen}
              >
                {content(true)}
              </button>
            ) : (
              <div class="settings-row oc-settings-row">{content(false)}</div>
            );
          }}
        </For>
      </SettingsSection>
    </div>
  ) : undefined;
}

function renderPluginMcpServers(
  names: readonly string[],
  details: PluginDiscoveryDetailResult["detail"]["mcpServerDetails"] = [],
  description?: string,
): JSX.Element {
  return renderPluginCapabilitySection(
    t(names.length === 1 ? "pluginsPage.detailMcpServer" : "pluginsPage.detailMcpServers"),
    names.map((name) => {
      const server = details.find((entry) => entry.name === name);
      const fields = [
        [
          t("pluginsPage.mcpDetails.endpoint"),
          server?.endpointRedacted ? t("pluginsPage.mcpDetails.endpointRedacted") : server?.url,
        ],
        [t("pluginsPage.mcpDetails.transport"), server?.transport],
        [
          t("pluginsPage.mcpDetails.authentication"),
          server?.auth ? t(`pluginsPage.mcpDetails.auth.${server.auth}`) : undefined,
        ],
        [t("pluginsPage.mcpDetails.scope"), server?.scope],
        [t("pluginsPage.mcpDetails.description"), description],
      ].filter(([, value]) => value);
      return {
        name,
        details: (
          <>
            {fields.length ? (
              <dl class="plugin-mcp-details">
                <For each={fields}>
                  {([label, value]) => (
                    <>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </>
                  )}
                </For>
              </dl>
            ) : undefined}
            {!description && server?.setup ? <p>{server.setup}</p> : undefined}
            {!fields.length && !server?.setup ? (
              <p>{t("pluginsPage.mcpDetails.unavailable")}</p>
            ) : undefined}
          </>
        ),
      };
    }),
    () => <Icon name="plug" />,
  );
}

// Ordered, route-local artwork describes user capabilities, not runtime plumbing.
const pluginCapabilityPaths = {
  speechProviders: "M3 5h8M7 5v10m-3 0h6m3-5h3l4-4v14l-4-4h-3Zm9 0v6",
  realtimeTranscriptionProviders:
    "M7 2za3 3 0 0 1 3 3v5a3 3 0 0 1-3 3 3 3 0 0 1-3-3V5a3 3 0 0 1 3-3m-6 8a6 6 0 0 0 12 0m-6 6v5m-3 0h6m6-15h6m-6 5h4m-4 5h6",
  realtimeVoiceProviders:
    "M2 10v4m4-7v10m4-7v4m4-7v10m4-7v4m4-7v10M4 3h13m-2-2 2 2-2 2m5 16H7m2-2-2 2 2 2",
  mediaUnderstandingProviders:
    "M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m13-5v4a1 1 0 0 1-1 1h-4M4 12s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5m10 0a2 2 0 1 1-4 0 2 2 0 1 1 4 0",
  imageGenerationProviders:
    "M12 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-8M3 17l5-5 4 4 3-3 6 6M18 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1ZM8.5 7.5a1 1 0 1 1-2 0 1 1 0 1 1 2 0",
  videoGenerationProviders:
    "M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M2 7h20M2 17h20M7 3v4m5-4v4m5-4v4M7 17v4m5-4v4m5-4v4m-7-11 5 2-5 2Z",
  musicGenerationProviders:
    "M9 18V5l12-3v13M9 9l12-3M3 2v4M1 4h4m4 14a3.5 3 0 1 1-7 0 3.5 3 0 1 1 7 0m12-3a3.5 3 0 1 1-7 0 3.5 3 0 1 1 7 0",
  embeddingProviders:
    "M7 5h10M6 7l5 9m7-9-5 9M8 5a3 3 0 1 1-6 0 3 3 0 1 1 6 0m14 0a3 3 0 1 1-6 0 3 3 0 1 1 6 0m-7 14a3 3 0 1 1-6 0 3 3 0 1 1 6 0m-6-8h6",
  webSearchProviders:
    "M14 8a6 6 0 1 1-12 0 6 6 0 1 1 12 0Z M8 2c-3 3-3 9 0 12 3-3 3-9 0-12Z M2 8h12 M21 17.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 1 1 7 0Z M20 20l2.5 2.5",
  webFetchProviders:
    "M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M2 8h20M6 5.5h.01M12 11v7m-3-3 3 3 3-3",
  webContentExtractors:
    "M11 21H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4M2 8h20M6 5.5h.01M6 12h6m-6 4h3m5 0h9m-3-3 3 3-3 3",
  documentExtractors:
    "M11 22H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9l5 5v4m-6-9v6h6M7 12h4m-4 4h3m4 1h9m-3-3 3 3-3 3",
  transcriptSourceProviders:
    "M7 2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2M2 6v14a2 2 0 0 0 2 2h13M9 7h3m-3 4h8m-8 4h6",
  migrationProviders:
    "M4 9V4a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v5m-7-8v13m-4-4 4 4 4-4M3 12l-1 8a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1l-1-8M2 16h5l2 3h6l2-3h5",
} as const;

function renderPluginDeclaredCapabilities(
  contracts: Readonly<Record<string, readonly string[]>> | undefined,
): JSX.Element {
  return renderPluginCapabilitySection(
    t("pluginsPage.detailCapabilities"),
    Object.entries(pluginCapabilityPaths)
      .filter(([family]) => contracts?.[family]?.length)
      .map(([family, path]) => ({
        icon: () => (
          <StrokeIcon aria-hidden="true">
            <path d={path} />
          </StrokeIcon>
        ),
        name: t(`pluginsPage.capabilityFamilies.${family}.name`),
        description: t(`pluginsPage.capabilityFamilies.${family}.description`),
      })),
  );
}

export function renderPluginContentCapabilities(params: {
  contracts: Readonly<Record<string, readonly string[]>> | undefined;
  uiCapabilities?: readonly PluginUiCapability[];
  skillsSection?: JSX.Element;
  skills: Array<{ name: string; description?: string }>;
  tools: Array<{ name: string; description?: string; onOpen?: () => void }>;
  mcpServers: readonly string[];
  mcpServerDetails?: PluginDiscoveryDetailResult["detail"]["mcpServerDetails"];
  mcpDescription?: string;
}): JSX.Element {
  return (
    <>
      {renderPluginDeclaredCapabilities(params.contracts)}
      {renderPluginCapabilitySection(
        t("pluginsPage.detailExtensions"),
        PLUGIN_UI_CAPABILITIES.filter((capability) =>
          params.uiCapabilities?.includes(capability),
        ).map((capability) => ({
          icon: () => <ExtensionIcon capability={capability} />,
          name: t(`pluginsPage.uiCapabilities.${capability}.name`),
          description: t(`pluginsPage.uiCapabilities.${capability}.description`),
        })),
      )}
      {params.skillsSection ??
        renderPluginCapabilitySection(t("pluginsPage.detailTabs.skills"), params.skills, () => (
          <Icon name="bookOpenText" />
        ))}
      {renderPluginCapabilitySection(t("pluginsPage.detailTools"), params.tools, () => (
        <Icon name="wrench" />
      ))}
      {renderPluginMcpServers(params.mcpServers, params.mcpServerDetails, params.mcpDescription)}
    </>
  );
}

export function renderPluginAskAction(onAsk?: () => void, primary = true) {
  return onAsk ? (
    <button
      type="button"
      class={["btn oc-action", { primary, "oc-action-secondary": !primary }]}
      onClick={onAsk}
    >
      {askBrandLabel(t)}
    </button>
  ) : undefined;
}
