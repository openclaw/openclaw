import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import {
  PLUGIN_UI_CAPABILITIES,
  type PluginUiCapability,
} from "../../../../packages/gateway-protocol/src/plugin-ui-capabilities.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
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

const SECURITY_STATUS_KIND = {
  pass: "ok",
  warning: "warn",
  danger: "danger",
  unknown: "muted",
} as const;

function PluginLinkRow(props: {
  title: string;
  href: string;
  class?: string;
  value?: JSX.Element;
}): JSX.Element {
  return (
    <a
      class={["settings-row settings-row--nav oc-settings-row", props.class]}
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div class="settings-row__text oc-settings-row-content">
        <span class="settings-row__title oc-settings-row-title">{props.title}</span>
      </div>
      <div class="settings-row__control oc-settings-row-control">
        {props.value}
        <span class="settings-row__chevron" aria-hidden="true">
          <Icon name="arrowUpRight" />
        </span>
      </div>
    </a>
  );
}

function renderPluginSecurityAudit(status: string, auditUrl: string | null | undefined) {
  const tone = securityTone(status);
  const label = () => (
    <SettingsStatus
      carapace
      kind={SECURITY_STATUS_KIND[tone]}
      label={tone === "pass" ? "Clean" : tone === "warning" ? "Review" : status}
    />
  );
  const toneClass = ["plugin-catalog-detail__security", `plugin-catalog-detail__security--${tone}`];
  return auditUrl ? (
    <PluginLinkRow
      class={toneClass.join(" ")}
      title={t("pluginsPage.detailSecurity")}
      href={auditUrl}
      value={label()}
    />
  ) : (
    <div class={[toneClass]}>
      <SettingsRow carapace title={t("pluginsPage.detailSecurity")} control={label()} />
    </div>
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
    <span class="plugin-catalog-detail__publisher">
      <span class="plugin-catalog-detail__publisher-name">
        {name ? <strong>{name}</strong> : renderPluginAuthor(handle)}
        {official ? renderPluginOfficialBadge() : undefined}
      </span>
      {name ? renderPluginAuthor(handle) : undefined}
    </span>
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
  local?: PluginsInspectResult["overview"],
  loading = false,
  /** The lifecycle rows already name the installed version. */
  installed = false,
): JSX.Element {
  const detail = result?.detail;
  const catalog = result?.plugin.catalog;
  const repository = pluginRepository(
    local?.repositoryUrl ?? detail?.repositoryUrl ?? detail?.verification?.sourceRepo,
  );
  const documentation = pluginWebUrl(local?.documentationUrl ?? detail?.documentationUrl);
  const categories = catalog?.categories ?? [];
  const values: Array<[string, string | undefined]> = [
    [t("pluginsPage.version"), installed ? undefined : catalog?.latestVersion],
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
      t("pluginsPage.detailUpdated"),
      detail?.updatedAt === undefined
        ? undefined
        : formatDateMs(detail.updatedAt, { dateStyle: "medium" }),
    ],
  ];
  const facts = values.filter(([label, value]) =>
    loading ? label !== t("pluginsPage.version") : value !== undefined,
  );
  return (
    <div
      class={{ "plugin-metadata__loading": loading }}
      role={loading ? "status" : undefined}
      aria-label={loading ? t("pluginsPage.detailLoading") : undefined}
    >
      <SettingsGroup carapace>
        {detail?.security
          ? renderPluginSecurityAudit(
              detail.security.verdict ?? "unknown",
              detail.security.auditUrl,
            )
          : undefined}
        <For each={facts}>
          {([label, value]) => (
            <SettingsRow
              carapace
              title={label}
              control={
                value === undefined ? (
                  <span class="plugin-metadata__placeholder skeleton" aria-hidden="true" />
                ) : (
                  <SettingsValue value={value} />
                )
              }
            />
          )}
        </For>
        {categories.length ? (
          <SettingsRow
            carapace
            title={t("pluginsPage.detailCategories")}
            control={
              <span class="plugin-metadata__categories">
                <SettingsValue value={categories.join(", ")} />
              </span>
            }
          />
        ) : undefined}
        {repository ? (
          <PluginLinkRow
            class="plugin-metadata__repository"
            title={t("pluginsPage.detailRepository")}
            href={repository.href}
            value={<SettingsValue value={repository.name} />}
          />
        ) : undefined}
        {documentation ? (
          <PluginLinkRow title={t("pluginsPage.detailDocumentation")} href={documentation.href} />
        ) : undefined}
      </SettingsGroup>
    </div>
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
