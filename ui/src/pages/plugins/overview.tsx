import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import {
  PLUGIN_UI_CAPABILITIES,
  type PluginUiCapability,
} from "../../../../packages/gateway-protocol/src/plugin-ui-capabilities.ts";
import { Icon } from "../../components/solid/icon.tsx";
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
import { renderPluginAuthor, renderPluginOfficialBadge } from "./plugin-card.tsx";
import { renderPluginRowMessage } from "./plugin-row-message.tsx";
import { renderPluginSecurityAudit } from "./security-audit.tsx";

registerEnglishCatalog(registerPluginManagementEnglish);

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
      t("pluginsPage.catalogDownloadsColumn"),
      catalog?.downloads === undefined ? undefined : formatCompactCount(catalog.downloads),
    ],
    [
      t("pluginsPage.detailPublished"),
      detail?.createdAt === undefined
        ? undefined
        : formatDateMs(detail.createdAt, { dateStyle: "medium" }),
    ],
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
          <h2>{t("pluginsPage.detailCategories")}</h2>
          <div class="plugin-metadata__categories">
            <For each={categories}>{(category) => <span class="chip">{category}</span>}</For>
          </div>
        </section>
      ) : undefined}
      {repository ? (
        <section class="plugin-metadata__section">
          <h2>{t("pluginsPage.detailRepository")}</h2>
          <a
            class="plugin-metadata__repository"
            href={repository.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {repository.github ? <Icon name="github" /> : <Icon name="externalLink" />}
            <span>{repository.name}</span>
          </a>
        </section>
      ) : undefined}
      {documentation ? (
        <section class="plugin-metadata__section">
          <h2>{t("pluginsPage.detailDocumentation")}</h2>
          <a href={documentation.href} target="_blank" rel="noopener noreferrer">
            {t("pluginsPage.detailDocumentation")} {<Icon name="arrowUpRight" />}
          </a>
        </section>
      ) : undefined}
    </>
  );
}

export function renderPluginCapabilitySection(
  title: string,
  values: Array<{
    name: string;
    description?: string;
    onOpen?: () => void;
    trailing?: JSX.Element;
    details?: JSX.Element;
  }>,
  icon: () => JSX.Element,
): JSX.Element {
  return values.length ? (
    <section class="plugin-capabilities">
      <h2>
        {title}
        <span>{values.length}</span>
      </h2>
      <div>
        <For each={values}>
          {(value) => {
            const open = value.onOpen;
            const content = (
              <>
                <span class="plugin-capability__icon" aria-hidden="true">
                  {icon()}
                </span>
                <span class="plugin-capability__copy">
                  <strong>{value.name}</strong>
                  {value.description ? <span>{value.description}</span> : undefined}
                </span>
                {value.trailing ? (
                  <span class="plugin-capability__trailing">{value.trailing}</span>
                ) : undefined}
                {open || value.details ? (
                  <span class="plugin-capability__chevron" aria-hidden="true">
                    {<Icon name="chevronRight" />}
                  </span>
                ) : undefined}
              </>
            );
            return (
              <div class="plugin-capability">
                {value.details ? (
                  <details class="plugin-capability__disclosure">
                    <summary>{content}</summary>
                    <div class="plugin-capability__details">{value.details}</div>
                  </details>
                ) : open ? (
                  <button type="button" onClick={open}>
                    {content}
                  </button>
                ) : (
                  <div class="plugin-capability__static">{content}</div>
                )}
              </div>
            );
          }}
        </For>
      </div>
    </section>
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

// Runtime plumbing is intentionally absent: the overview describes user capabilities.
const overviewContractFamilies = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "embeddingProviders",
  "webSearchProviders",
  "webFetchProviders",
  "webContentExtractors",
  "documentExtractors",
  "transcriptSourceProviders",
  "migrationProviders",
] as const;

function renderPluginDeclaredCapabilities(
  contracts: Readonly<Record<string, readonly string[]>> | undefined,
  uiCapabilities?: readonly PluginUiCapability[],
): JSX.Element {
  return renderPluginCapabilitySection(
    t("pluginsPage.detailCapabilities"),
    [
      ...overviewContractFamilies
        .filter((family) => contracts?.[family]?.length)
        .map((family) => `capabilityFamilies.${family}`),
      ...PLUGIN_UI_CAPABILITIES.filter((capability) => uiCapabilities?.includes(capability)).map(
        (capability) => `uiCapabilities.${capability}`,
      ),
    ].map((key) => ({
      name: t(`pluginsPage.${key}.name`),
      description: t(`pluginsPage.${key}.description`),
    })),
    () => <Icon name="layers" />,
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
      {renderPluginDeclaredCapabilities(params.contracts, params.uiCapabilities)}
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
      class={[
        "btn oc-action",
        { primary, "oc-action-primary": primary, "oc-action-secondary": !primary },
      ]}
      onClick={onAsk}
    >
      {askBrandLabel(t)}
    </button>
  ) : undefined;
}
