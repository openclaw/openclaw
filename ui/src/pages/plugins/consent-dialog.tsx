import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show, For } from "solid-js";
import type { CapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  PLUGIN_DECLARED_SURFACE_GROUPS,
  type PluginDeclaredSurfaceGroup,
} from "../../../../packages/gateway-protocol/src/schema/plugin-declared-surface-groups.js";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { registerPluginConsentEnglish } from "../../i18n/locales/en-plugin-consent.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import type {
  PluginDeclaredSurface,
  PluginHookGrant,
  PluginInspectSource,
  PluginOperatorGrants,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { pluginFallbackGradient, pluginMonogram } from "./presentation.ts";
import { ReasonedDisabledControl } from "./reasoned-disabled-control.tsx";

registerEnglishCatalog(registerPluginManagementEnglish);

registerEnglishCatalog(registerPluginConsentEnglish);

export type PluginConsentIntent = { kind: "enable"; pluginId: string; rowKey: string };

type PluginConsentFallback = {
  name: string;
  version?: string;
  official?: boolean;
};

export type PluginConsentState = {
  intent: PluginConsentIntent;
  pluginId: string;
  fallback: PluginConsentFallback;
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

type ArtTileOptions = {
  iconUrl?: string;
  onIconError?: () => void;
  authorIconUrl?: string;
  loading?: boolean;
  className?: string;
  whiteBackground?: boolean;
};

export function renderArtTile(
  slug: string,
  name: string,
  options: ArtTileOptions = {},
): JSX.Element {
  return <PluginArtTile slug={slug} name={name} options={options} />;
}

export function PluginArtTile(props: {
  slug: string;
  name: string;
  options: ArtTileOptions;
}): JSX.Element {
  type ImageState = { source: string | undefined; status: "loading" | "ready" | "failed" };
  const [packageImage, setPackageImage] = createSignal<ImageState>((previous) => {
    const source = props.options.iconUrl;
    return previous && previous.source === source ? previous : { source, status: "loading" };
  });
  const [authorImage, setAuthorImage] = createSignal<ImageState>((previous) => {
    const source = props.options.authorIconUrl;
    return previous && previous.source === source ? previous : { source, status: "loading" };
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const currentImage = () =>
    packageImage().source && packageImage().status !== "failed"
      ? { state: packageImage(), update: setPackageImage, package: true }
      : { state: authorImage(), update: setAuthorImage, package: false };
  const source = () =>
    currentImage().state.status === "failed" ? undefined : currentImage().state.source;
  const pending = () =>
    source() ? currentImage().state.status === "loading" : Boolean(props.options.loading);
  const className = () => props.options.className ?? "plugins-tile";
  const settle = (url: string, status: "ready" | "failed") => {
    const image = currentImage();
    if (disposed || image.state.source !== url) {
      return;
    }
    image.update({ ...image.state, status });
    if (status === "failed" && image.package) {
      props.options.onIconError?.();
    }
  };
  // Only the displayed image is admitted; failed sources stay failed until their URL changes.
  return (
    <>
      {source() || pending() ? (
        <span
          class={[
            className(),
            { "plugins-tile--white": props.options.whiteBackground, skeleton: pending() },
          ]}
          data-plugin-icon-id={props.slug}
          aria-hidden="true"
        >
          <Show when={source()} keyed>
            {(url) => (
              <img
                class="plugins-icon"
                src={url}
                alt=""
                loading="eager"
                decoding="async"
                hidden={pending()}
                onLoad={() => settle(url, "ready")}
                onError={() => settle(url, "failed")}
              />
            )}
          </Show>
        </span>
      ) : (
        <span
          class={[className(), `${className()}--fallback`]}
          data-plugin-icon-id={props.slug}
          style={{
            "--plugins-art-a": pluginFallbackGradient(props.slug)[0],
            "--plugins-art-b": pluginFallbackGradient(props.slug)[1],
          }}
          aria-hidden="true"
        >
          {pluginMonogram(props.name) ? (
            <span>{pluginMonogram(props.name)}</span>
          ) : (
            <Icon name="plug" />
          )}
        </span>
      )}
    </>
  );
}

function renderPluginMetaRow(label: string, value: JSX.Element | string, warning = false) {
  return (
    <SettingsRow
      {...{
        title: label,
        control: <span class={warning ? "plugins-consent__row--warning" : ""}> {value}</span>,
        stackedOnNarrow: true,
        carapace: true,
      }}
    />
  );
}

function renderCapabilityItems(items: readonly string[]) {
  return <span class="plugins-consent__items">{items.join(", ")}</span>;
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

function renderPluginDeclaredCapabilities(declared: PluginDeclaredSurface): JSX.Element {
  const rows = renderCapabilityRows(declared);
  return (
    <SettingsSection
      {...{
        title: t("pluginConsent.declaredTitle"),
        description: t("pluginConsent.declaredDescription"),
        carapace: true,
      }}
    >
      {
        <>
          {rows.length ? (
            rows
          ) : (
            <SettingsRow {...{ title: t("pluginConsent.declaredEmpty"), carapace: true }} />
          )}
          {declared.hooks.length === 0
            ? renderPluginMetaRow(t("pluginConsent.hooks"), t("pluginConsent.runtimeHooks"))
            : undefined}
          {declared.dangerousConfigFlags.length > 0
            ? renderPluginMetaRow(
                t("pluginConsent.dangerousFlags"),
                renderCapabilityItems(declared.dangerousConfigFlags),
                true,
              )
            : undefined}
        </>
      }
    </SettingsSection>
  );
}

function renderWidenedCapabilities(details: CapabilityConsentErrorDetails) {
  if (!details.widened) {
    return undefined;
  }
  const rows = renderCapabilityRows(details.widened, true);
  if (rows.length === 0) {
    return undefined;
  }
  return (
    <section class="plugins-consent__section oc-section">
      <h3>{t("pluginConsent.widenedTitle")}</h3>
      <p class="plugins-consent__description">
        {t("pluginConsent.widenedDescription")}
        {details.acceptedAt
          ? t("pluginConsent.previouslyAccepted", { date: details.acceptedAt })
          : undefined}
      </p>
      <div class="plugins-consent__rows">{rows}</div>
    </section>
  );
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

function renderPluginGrants(grants: PluginOperatorGrants, origin?: string): JSX.Element {
  const conversation = grants.hooks.allowConversationAccess;
  return (
    <SettingsSection
      {...{
        title: t("pluginConsent.grantsTitle"),
        description: t("pluginConsent.grantsDescription"),
        carapace: true,
      }}
    >
      {
        <>
          {renderPluginMetaRow(
            t("pluginConsent.promptInjection"),
            grantValue(
              grants.hooks.allowPromptInjection,
              "pluginConsent.allowed",
              "pluginConsent.blocked",
            ),
          )}
          {renderPluginMetaRow(
            t("pluginConsent.conversationAccess"),
            <>
              {grantValue(conversation, "pluginConsent.on", "pluginConsent.off")}
              {!conversation.effective &&
              conversation.configured === undefined &&
              origin !== "bundled" ? (
                <span class="plugins-consent__hint">{t("pluginConsent.externalAccessHint")}</span>
              ) : undefined}
            </>,
          )}
          <For each={["llm", "subagent"] as const}>
            {(key) => {
              const overrides = grants[key];
              return overrides
                ? renderPluginMetaRow(
                    t(
                      key === "llm"
                        ? "pluginConsent.modelOverrides"
                        : "pluginConsent.subagentModelOverrides",
                    ),
                    modelOverrideSummary(overrides),
                  )
                : undefined;
            }}
          </For>
        </>
      }
    </SettingsSection>
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
    return undefined;
  }
  const integrityLabel =
    source.integrityKind === "sha256"
      ? t("pluginConsent.sha256")
      : source.integrityKind === "git-commit"
        ? t("pluginConsent.commit")
        : t("pluginConsent.integrity");
  return (
    <>
      <div class="plugins-consent__provenance">
        <span>
          {[t(SOURCE_KIND_LABELS[source.kind]), source.spec ?? source.packageName]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {source.integrity ? (
          <span title={source.integrity}>
            {integrityLabel}: <code>{source.integrity.slice(0, 20)}…</code>
          </span>
        ) : undefined}
      </div>
      {source.integrity ? (
        <p class="plugins-consent__hint">{t("pluginConsent.pinnedArtifact")}</p>
      ) : undefined}
    </>
  );
}

function renderTrust(trust: PluginsInspectResult["trust"]) {
  if (!trust) {
    return undefined;
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
  return (
    <section class="plugins-consent__trust">
      {<SettingsStatus {...{ kind, label, carapace: true }} />}
      {trust.reasons?.length ? (
        <ul>
          <For each={trust.reasons}>{(reason) => <li>{reason}</li>}</For>
        </ul>
      ) : undefined}
      {trust.checkedAt ? (
        <p class="plugins-consent__hint">
          {t("pluginConsent.scanDate", { date: trust.checkedAt })}
        </p>
      ) : undefined}
    </section>
  );
}

export function renderPluginConsentDialog(props: PluginConsentDialogProps): JSX.Element {
  const consent = () => props.consent;
  const inspection = () => props.inspection;
  const details = () => consent().details;
  const plugin = () => inspection()?.plugin;
  const fallback = () => consent().fallback;
  const packageName = () => inspection()?.source?.packageName;
  const slug = () => consent().pluginId;
  const name = () => plugin()?.name ?? fallback().name;
  const version = () => plugin()?.version ?? fallback().version;
  const origin = () => pluginOriginLabel(plugin()?.origin, fallback().official);
  const meta = () => [origin(), packageName()].filter(Boolean).join(" · ");
  const action = () =>
    props.busy ? t("pluginsPage.working") : t("pluginConsent.enableNamed", { name: name() });
  const confirmUnavailable = () =>
    !props.canMutate || props.busy || props.loading || Boolean(props.error) || !inspection();
  const confirm = (
    <button
      type="button"
      class="btn primary oc-action oc-action-primary"
      disabled={confirmUnavailable() && !props.mutationBlockedReason}
      aria-disabled={!props.canMutate ? "true" : undefined}
      onClick={() => {
        if (confirmUnavailable()) {
          return;
        }
        props.onConfirm();
      }}
    >
      {action()}
    </button>
  );
  return (
    <openclaw-modal-dialog
      label={name()}
      style={{ "--openclaw-modal-width": "min(560px, calc(100vw - 32px))" }}
      onModal-cancel={() => props.onCancel()}
    >
      <section class="plugins-consent oc-card" data-plugin-consent={consent().intent.kind}>
        <header class="plugins-consent__header">
          {renderArtTile(slug(), name(), { iconUrl: props.iconUrl, loading: props.iconLoading })}
          <div>
            <div class="plugins-detail__title">
              <h2>{name()}</h2>
              {version() ? <span class="plugins-version">{`v${version()}`}</span> : undefined}
            </div>
            {meta() ? <p class="plugins-consent__description">{meta()}</p> : undefined}
          </div>
        </header>
        {props.loading ? (
          <p class="plugins-consent__hint" role="status">
            {t("pluginConsent.loading")}
          </p>
        ) : props.error ? (
          <div class="plugins-consent__error" role="alert">
            <span>{props.error}</span>
            <button
              type="button"
              class="btn btn--sm oc-action oc-action-secondary"
              onClick={props.onRetry}
            >
              {t("pluginsPage.tryAgain")}
            </button>
          </div>
        ) : inspection() ? (
          <>
            {renderProvenance(inspection()!.source)} {renderTrust(inspection()!.trust)}
            {details() ? renderWidenedCapabilities(details()!) : undefined}
            {renderPluginDeclaredCapabilities(inspection()!.declared)}
            {renderPluginGrants(inspection()!.grants, plugin()?.origin)}
          </>
        ) : (
          <p class="plugins-consent__description">{t("pluginConsent.fallback")}</p>
        )}
        <footer class="plugins-consent__actions">
          <button
            type="button"
            class="btn oc-action oc-action-secondary"
            onClick={() => props.onCancel()}
          >
            {t("pluginsPage.cancel")}
          </button>
          <ReasonedDisabledControl reason={props.mutationBlockedReason}>
            {confirm}
          </ReasonedDisabledControl>
        </footer>
      </section>
    </openclaw-modal-dialog>
  );
}
