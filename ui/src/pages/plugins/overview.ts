import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatDateMs } from "../../lib/format.ts";
import type { PluginDiscoveryDetailResult, PluginsInspectResult } from "../../lib/plugins/index.ts";
import { formatCompactCount } from "./catalog-results.ts";
import { renderPluginAuthor, renderPluginOfficialBadge } from "./plugin-card.ts";
import { renderPluginSecurityAudit } from "./security-audit.ts";

function pluginWebUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return /^https?:$/u.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
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

export function renderPluginPublisher(
  result: PluginDiscoveryDetailResult | undefined,
  localName?: string,
): TemplateResult {
  const author = result?.detail.author;
  const handle = author?.handle ?? result?.plugin.catalog.author;
  return html`<div class="plugin-catalog-detail__publisher">
    ${author?.displayName || localName ? html`<strong>${author?.displayName ?? localName}</strong>` : nothing}
    ${author?.official === true ? renderPluginOfficialBadge() : nothing}
    ${handle ? renderPluginAuthor(handle, { linked: true }) : nothing}
  </div>`;
}

export function renderPluginMetadata(
  result: PluginDiscoveryDetailResult | undefined,
  installedVersion?: string,
  local?: PluginsInspectResult["overview"],
): TemplateResult {
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
  return html`
    ${detail?.security ? renderPluginSecurityAudit(detail.security.verdict ?? "unknown", detail.security.auditUrl) : nothing}
    ${
      values.some(([, value]) => value !== undefined)
        ? html`<dl class="plugin-metadata__facts">
            ${values
              .filter(([, value]) => value !== undefined)
              .map(
                ([label, value]) =>
                  html`<div>
                    <dt>${label}</dt>
                    <dd>${value}</dd>
                  </div>`,
              )}
          </dl>`
        : nothing
    }
    ${
      categories.length
        ? html`<section class="plugin-metadata__section">
            <h2>${t("pluginsPage.detailCategories")}</h2>
            <div class="plugin-metadata__categories">
              ${categories.map((category) => html`<span class="plugin-catalog-detail__tag">${category}</span>`)}
            </div>
          </section>`
        : nothing
    }
    ${
      repository
        ? html`<section class="plugin-metadata__section">
            <h2>${t("pluginsPage.detailRepository")}</h2>
            <a
              class="plugin-metadata__repository"
              href=${repository.href}
              target="_blank"
              rel="noopener noreferrer"
              >${repository.github ? icons.github : icons.externalLink}<span
                >${repository.name}</span
              ></a
            >
          </section>`
        : nothing
    }
    ${
      documentation
        ? html`<section class="plugin-metadata__section">
            <h2>${t("pluginsPage.detailDocumentation")}</h2>
            <a href=${documentation.href} target="_blank" rel="noopener noreferrer"
              >${t("pluginsPage.detailDocumentation")} ${icons.arrowUpRight}</a
            >
          </section>`
        : nothing
    }
  `;
}

export function renderPluginCapabilitySection(
  title: string,
  values: Array<{ name: string; description?: string }>,
  icon: TemplateResult,
  onOpen?: (name: string) => void,
): TemplateResult {
  return html`${
    values.length
      ? html`<section class="plugin-capabilities">
          <h2>${title}<span>${values.length}</span></h2>
          <div>
            ${values.map((value) => {
              const content = html`<span class="plugin-capability__icon" aria-hidden="true"
                  >${icon}</span
                ><span class="plugin-capability__copy"
                  ><strong>${value.name}</strong
                  >${value.description ? html`<span>${value.description}</span>` : nothing}</span
                >${onOpen ? icons.chevronRight : nothing}`;
              return html`<div class="plugin-capability">
                ${onOpen ? html`<button type="button" @click=${() => onOpen(value.name)}>${content}</button>` : html`<div class="plugin-capability__static">${content}</div>`}
              </div>`;
            })}
          </div>
        </section>`
      : nothing
  }`;
}

export function renderPluginAskAction(onAsk?: () => void) {
  return onAsk
    ? html`<button type="button" class="btn oc-action oc-action-secondary" @click=${onAsk}>
        ${t("nav.askOpenClaw")}
      </button>`
    : nothing;
}
