import { html, nothing, type TemplateResult } from "lit";
import type { CapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  PLUGIN_DECLARED_SURFACE_GROUPS,
  type PluginDeclaredSurfaceGroup,
} from "../../../../packages/gateway-protocol/src/schema/plugin-declared-surface-groups.js";
import { icons } from "../../components/icons.ts";
import { imageWithFallback, type ImageLoadingState } from "../../components/image-with-fallback.ts";
import "../../components/modal-dialog.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginConsentEnglish } from "../../i18n/locales/en-plugin-consent.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import type {
  PluginDeclaredSurface,
  PluginHookGrant,
  PluginInspectSource,
  PluginOperatorGrants,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { pluginFallbackGradient, pluginMonogram } from "./presentation.ts";

registerPluginManagementEnglish();

registerPluginConsentEnglish();

export type PluginConsentIntent = { kind: "enable"; pluginId: string; rowKey: string };

type PluginConsentFallback = {
  name: string;
  version?: string;
  official?: boolean;
};

export type PluginConsentState = {
  intent: PluginConsentIntent;
  pluginId: string | null;
  fallback: PluginConsentFallback | null;
  details?: CapabilityConsentErrorDetails;
};

type PluginConsentDialogProps = {
  consent: PluginConsentState;
  inspection: PluginsInspectResult | null;
  loading: boolean;
  error: string | null;
  iconUrl?: string;
  iconLoading?: boolean;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
};

export function renderArtTile(
  slug: string,
  name: string,
  options: {
    iconUrl?: string;
    onIconError?: () => void;
    authorIconUrl?: string;
    loading?: boolean;
    className?: string;
    whiteBackground?: boolean;
  } = {},
): TemplateResult {
  const {
    iconUrl,
    onIconError,
    authorIconUrl,
    loading = false,
    className = "plugins-tile",
    whiteBackground = false,
  } = options;
  // Fetch admission already limits requests to rendered tiles. Eager loading
  // lets the hidden image finish before replacing its skeleton.
  const renderTile = (url: string | null, onError: () => void, image: ImageLoadingState) => {
    const pending = url ? image.loading : loading;
    if (url || pending) {
      return html`<span
        class=${`${className}${whiteBackground ? " plugins-tile--white" : ""}${pending ? " skeleton" : ""}`}
        data-plugin-icon-id=${slug}
        aria-hidden="true"
      >
        ${
          url
            ? html`<img
                class="plugins-icon"
                src=${url}
                alt=""
                loading="eager"
                decoding="async"
                ?hidden=${pending}
                @load=${image.onLoad}
                @error=${() => {
                  onError();
                  onIconError?.();
                }}
              />`
            : nothing
        }
      </span>`;
    }
    const [from, to] = pluginFallbackGradient(slug);
    const monogram = pluginMonogram(name);
    return html`<span
      class=${`${className} ${className}--fallback`}
      data-plugin-icon-id=${slug}
      style=${`--plugins-art-a:${from};--plugins-art-b:${to}`}
      aria-hidden="true"
    >
      ${monogram ? html`<span>${monogram}</span>` : icons.plug}
    </span>`;
  };
  return html`${imageWithFallback(iconUrl, (url, onError, image) =>
    url ? renderTile(url, onError, image) : html`${imageWithFallback(authorIconUrl, renderTile)}`,
  )}`;
}

function renderPluginMetaRow(label: string, value: TemplateResult | string, warning = false) {
  return renderSettingsRow({
    title: label,
    control: html`<span class=${warning ? "plugins-consent__row--warning" : ""}>${value}</span>`,
    stackedOnNarrow: true,
    carapace: true,
  });
}

function renderCapabilityItems(items: readonly string[]) {
  return html`<span class="plugins-consent__items">${items.join(", ")}</span>`;
}

const CAPABILITY_GROUP_LABELS = {
  channels: "pluginsPage.categoryChannels",
  providers: "pluginsPage.categoryProviders",
  tools: "pluginsPage.categoryTools",
  contracts: "pluginConsent.contracts",
  hooks: "pluginConsent.hooks",
  mcpServers: "pluginConsent.mcpServers",
  cliCommands: "pluginConsent.cliCommands",
  cliBackends: "pluginConsent.cliBackends",
  skills: "pluginConsent.skills",
  dangerousConfigFlags: "pluginConsent.dangerousFlags",
} as const satisfies Record<PluginDeclaredSurfaceGroup, string>;

function renderCapabilityRows(surface: Partial<PluginDeclaredSurface>, widened = false) {
  return PLUGIN_DECLARED_SURFACE_GROUPS.flatMap((group) => {
    const items = surface[group];
    return items?.length && (widened || group !== "dangerousConfigFlags")
      ? [
          renderPluginMetaRow(
            t(CAPABILITY_GROUP_LABELS[group]),
            renderCapabilityItems(items),
            widened,
          ),
        ]
      : [];
  });
}

function renderPluginDeclaredCapabilities(declared: PluginDeclaredSurface): TemplateResult {
  const rows = renderCapabilityRows(declared);
  return renderSettingsSection(
    {
      title: t("pluginConsent.declaredTitle"),
      description: t("pluginConsent.declaredDescription"),
      carapace: true,
    },
    html`${rows.length ? rows : renderSettingsRow({ title: t("pluginConsent.declaredEmpty"), carapace: true })}
    ${declared.hooks.length === 0 ? renderPluginMetaRow(t("pluginConsent.hooks"), t("pluginConsent.runtimeHooks")) : nothing}
    ${declared.dangerousConfigFlags.length > 0 ? renderPluginMetaRow(t("pluginConsent.dangerousFlags"), renderCapabilityItems(declared.dangerousConfigFlags), true) : nothing}`,
  );
}

function renderWidenedCapabilities(details: CapabilityConsentErrorDetails) {
  if (!details.widened) {
    return nothing;
  }
  const rows = renderCapabilityRows(details.widened, true);
  if (rows.length === 0) {
    return nothing;
  }
  return html`
    <section class="plugins-consent__section oc-section">
      <h3>${t("pluginConsent.widenedTitle")}</h3>
      <p class="plugins-consent__description">
        ${t("pluginConsent.widenedDescription")}
        ${
          details.acceptedAt
            ? t("pluginConsent.previouslyAccepted", { date: details.acceptedAt })
            : nothing
        }
      </p>
      <div class="plugins-consent__rows">${rows}</div>
    </section>
  `;
}

function grantValue(grant: PluginHookGrant, on: string, off: string) {
  return `${t(grant.effective ? on : off)} ${t(
    grant.configured === undefined ? "pluginConsent.grantDefault" : "pluginConsent.grantConfigured",
  )}`;
}

function modelOverrideValue(key: string, allowed: boolean | undefined): string | undefined {
  return allowed === undefined
    ? undefined
    : t(key, { value: t(allowed ? "pluginConsent.allowed" : "pluginConsent.blocked") });
}

function modelOverrideSummary(
  overrides: NonNullable<PluginOperatorGrants["llm"] | PluginOperatorGrants["subagent"]>,
): string {
  const values = [
    modelOverrideValue("pluginConsent.modelOverride", overrides.allowModelOverride),
    overrides.allowedModels?.length
      ? t("pluginConsent.allowedModels", { models: overrides.allowedModels.join(", ") })
      : undefined,
    "allowedCompletionModels" in overrides && overrides.allowedCompletionModels?.length
      ? t("pluginConsent.allowedCompletionModels", {
          models: overrides.allowedCompletionModels.join(", "),
        })
      : undefined,
    "allowAuthProfileOverride" in overrides
      ? modelOverrideValue("pluginConsent.authProfileOverride", overrides.allowAuthProfileOverride)
      : undefined,
    "allowAgentIdOverride" in overrides
      ? modelOverrideValue("pluginConsent.agentIdOverride", overrides.allowAgentIdOverride)
      : undefined,
  ];
  return values.filter(Boolean).join(" · ") || t("pluginConsent.noOverrides");
}

function renderPluginGrants(grants: PluginOperatorGrants, origin?: string): TemplateResult {
  const conversation = grants.hooks.allowConversationAccess;
  return renderSettingsSection(
    {
      title: t("pluginConsent.grantsTitle"),
      description: t("pluginConsent.grantsDescription"),
      carapace: true,
    },
    html`
      ${renderPluginMetaRow(
        t("pluginConsent.promptInjection"),
        grantValue(
          grants.hooks.allowPromptInjection,
          "pluginConsent.allowed",
          "pluginConsent.blocked",
        ),
      )}
      ${renderPluginMetaRow(
        t("pluginConsent.conversationAccess"),
        html`
          ${grantValue(conversation, "pluginConsent.on", "pluginConsent.off")}
          ${
            !conversation.effective && conversation.configured === undefined && origin !== "bundled"
              ? html`<span class="plugins-consent__hint">
                  ${t("pluginConsent.externalAccessHint")}
                </span>`
              : nothing
          }
        `,
      )}
      ${
        grants.llm
          ? renderPluginMetaRow(t("pluginConsent.modelOverrides"), modelOverrideSummary(grants.llm))
          : nothing
      }
      ${
        grants.subagent
          ? renderPluginMetaRow(
              t("pluginConsent.subagentModelOverrides"),
              modelOverrideSummary(grants.subagent),
            )
          : nothing
      }
    `,
  );
}

const SOURCE_KIND_LABELS = {
  bundled: "pluginsPage.included",
  "official-catalog": "pluginsPage.official",
  clawhub: "pluginConsent.sourceClawHub",
  npm: "pluginConsent.sourceNpm",
  git: "pluginConsent.sourceGit",
  path: "pluginConsent.sourcePath",
  archive: "pluginConsent.sourceArchive",
  marketplace: "pluginConsent.sourceMarketplace",
} as const satisfies Record<PluginInspectSource["kind"], string>;

const PLUGIN_ORIGIN_LABELS: Readonly<Record<string, string>> = {
  bundled: "pluginsPage.included",
  global: "pluginsPage.global",
  workspace: "pluginsPage.workspace",
  config: "pluginsPage.config",
  official: "pluginsPage.official",
};

function pluginOriginLabel(origin: string, official?: boolean): string;
function pluginOriginLabel(origin: string | undefined, official?: boolean): string | null;
function pluginOriginLabel(origin: string | undefined, official?: boolean): string | null {
  if (official) {
    return t("pluginsPage.official");
  }
  const label =
    origin && Object.hasOwn(PLUGIN_ORIGIN_LABELS, origin)
      ? PLUGIN_ORIGIN_LABELS[origin]
      : undefined;
  return label ? t(label) : (origin ?? (official === false ? t("pluginConsent.community") : null));
}

function renderProvenance(source: PluginInspectSource | undefined) {
  if (!source) {
    return nothing;
  }
  const integrityLabel =
    source.integrityKind === "sha256"
      ? t("pluginConsent.sha256")
      : source.integrityKind === "git-commit"
        ? t("pluginConsent.commit")
        : t("pluginConsent.integrity");
  return html`
    <div class="plugins-consent__provenance">
      <span
        >${[t(SOURCE_KIND_LABELS[source.kind]), source.spec ?? source.packageName]
          .filter(Boolean)
          .join(" · ")}</span
      >
      ${
        source.integrity
          ? html`<span title=${source.integrity}>
              ${integrityLabel}: <code>${source.integrity.slice(0, 20)}…</code>
            </span>`
          : nothing
      }
    </div>
    ${
      source.integrity
        ? html`<p class="plugins-consent__hint">${t("pluginConsent.pinnedArtifact")}</p>`
        : nothing
    }
  `;
}

function renderTrust(trust: PluginsInspectResult["trust"]) {
  if (!trust) {
    return nothing;
  }
  const label = t(
    trust.disposition === "clean"
      ? "pluginConsent.verifiedClean"
      : trust.disposition === "review-recommended"
        ? "pluginConsent.reviewRecommended"
        : trust.disposition === "review-required"
          ? "pluginConsent.reviewRequired"
          : "pluginConsent.trustBlocked",
  );
  const kind =
    trust.disposition === "clean" ? "ok" : trust.disposition === "blocked" ? "danger" : "warn";
  return html`
    <section class="plugins-consent__trust">
      ${renderSettingsStatus({ kind, label, carapace: true })}
      ${
        trust.reasons?.length
          ? html`<ul>
              ${trust.reasons.map((reason) => html`<li>${reason}</li>`)}
            </ul>`
          : nothing
      }
      ${
        trust.checkedAt
          ? html`<p class="plugins-consent__hint">
              ${t("pluginConsent.scanDate", { date: trust.checkedAt })}
            </p>`
          : nothing
      }
    </section>
  `;
}

export function renderPluginConsentDialog(props: PluginConsentDialogProps): TemplateResult {
  const { consent, inspection } = props;
  const details = consent.details;
  const plugin = inspection?.plugin;
  const fallback = consent.fallback;
  const packageName = inspection?.source?.packageName;
  const slug = consent.pluginId ?? packageName ?? fallback?.name ?? "plugin";
  const name = plugin?.name ?? fallback?.name ?? slug;
  const version = plugin?.version ?? fallback?.version;
  const origin = pluginOriginLabel(plugin?.origin, fallback?.official);
  const meta = [origin, packageName].filter(Boolean).join(" · ");
  const action = props.busy ? t("pluginsPage.working") : t("pluginConsent.enableNamed", { name });
  const confirmUnavailable =
    !props.canMutate || props.busy || props.loading || Boolean(props.error) || !inspection;
  const confirm = html`
    <button
      type="button"
      class="btn primary oc-action oc-action-primary"
      ?disabled=${confirmUnavailable && !props.mutationBlockedReason}
      aria-disabled=${!props.canMutate ? "true" : nothing}
      @click=${() => {
        if (confirmUnavailable) {
          return;
        }
        props.onConfirm();
      }}
    >
      ${action}
    </button>
  `;
  return html`
    <openclaw-modal-dialog
      label=${name}
      style="--openclaw-modal-width: min(560px, calc(100vw - 32px));"
      @modal-cancel=${props.onCancel}
    >
      <section class="plugins-consent oc-card" data-plugin-consent=${consent.intent.kind}>
        <header class="plugins-consent__header">
          ${renderArtTile(slug, name, { iconUrl: props.iconUrl, loading: props.iconLoading })}
          <div>
            <div class="plugins-detail__title">
              <h2>${name}</h2>
              ${version ? html`<span class="plugins-version">${`v${version}`}</span>` : nothing}
            </div>
            ${meta ? html`<p class="plugins-consent__description">${meta}</p>` : nothing}
          </div>
        </header>
        ${
          props.loading
            ? html`<p class="plugins-consent__hint" role="status">${t("pluginConsent.loading")}</p>`
            : props.error
              ? html`<div class="plugins-consent__error" role="alert">
                  <span>${props.error}</span>
                  <button
                    type="button"
                    class="btn btn--sm oc-action oc-action-secondary"
                    @click=${props.onRetry}
                  >
                    ${t("pluginsPage.tryAgain")}
                  </button>
                </div>`
              : inspection
                ? html`
                    ${renderProvenance(inspection.source)} ${renderTrust(inspection.trust)}
                    ${details ? renderWidenedCapabilities(details) : nothing}
                    ${renderPluginDeclaredCapabilities(inspection.declared)}
                    ${renderPluginGrants(inspection.grants, plugin?.origin)}
                  `
                : html`<p class="plugins-consent__description">${t("pluginConsent.fallback")}</p>`
        }
        <footer class="plugins-consent__actions">
          <button type="button" class="btn oc-action oc-action-secondary" @click=${props.onCancel}>
            ${t("pluginsPage.cancel")}
          </button>
          ${renderReasonedDisabledControl(props.mutationBlockedReason, confirm)}
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
