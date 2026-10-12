import type { JSX } from "@solidjs/web";
import { Match, Show, Switch } from "solid-js";
import type { GitHubIdentityFacts } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { handleCopyButton } from "../../components/copy-button.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsRow,
  SettingsSecretInput,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerGitHubEnglish } from "../../i18n/locales/en-github.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { GitHubIdentityController } from "./github-identity-controller.ts";

const GITHUB_CREDENTIAL_STATUS = {
  available: { kind: "ok", label: "agentTools.githubStateVerified" },
  unverified: { kind: "warn", label: "agentTools.githubStateUnverified" },
  rate_limited: { kind: "warn", label: "agentTools.githubStateRateLimited" },
  unavailable: { kind: "danger", label: "agentTools.githubStateUnavailable" },
  configured_unavailable: { kind: "danger", label: "agentTools.githubStateConfiguredUnavailable" },
} as const;
const GITHUB_CREDENTIAL_KIND = {
  native: "agentTools.githubKindNative",
  "managed-pat": "agentTools.githubKindPat",
  "managed-oauth": "agentTools.githubKindOAuth",
} as const;
const GITHUB_REFRESH_STATE = {
  available: "agentTools.githubRefreshAvailable",
  expired: "agentTools.githubRefreshExpired",
  unavailable: "agentTools.githubRefreshUnavailable",
  refreshing: "agentTools.githubRefreshRefreshing",
  failed: "agentTools.githubRefreshFailed",
  not_applicable: "common.na",
} as const;
const GITHUB_AUTHORIZATION_LABEL = {
  code: "agentTools.githubCodeReady",
  pending: "agentTools.githubWaiting",
  cancelling: "agentTools.githubCancelling",
  finishing: "agentTools.githubFinishing",
  cancel_error: "agentTools.githubCancelFailed",
  network_error: "agentTools.githubNetworkRetry",
} as const;

type RequestStatus = Pick<GitHubIdentityController, "loading" | "error">;
type ControllerProps = { controller: GitHubIdentityController };

export function GitHubUnloadedStatus(props: { request: RequestStatus }) {
  return (
    <SettingsStatus
      kind={props.request.error ? "warn" : "muted"}
      label={
        props.request.loading
          ? t("githubConnections.checking")
          : props.request.error
            ? t("githubConnections.statusUnavailable")
            : t("githubConnections.notLoaded")
      }
    />
  );
}

export function GitHubHealth(props: {
  identity: GitHubIdentityFacts | null;
  request: RequestStatus;
}) {
  return (
    <Show when={props.identity} fallback={<GitHubUnloadedStatus request={props.request} />}>
      {(identity) => (
        <SettingsStatus
          kind={GITHUB_CREDENTIAL_STATUS[identity().credentialState].kind}
          label={t(GITHUB_CREDENTIAL_STATUS[identity().credentialState].label)}
        />
      )}
    </Show>
  );
}

export function GitHubDetails(props: { identity: GitHubIdentityFacts | null }) {
  return (
    <Show when={props.identity}>
      {(identity) => (
        <details class="settings-row settings-row--stacked">
          <summary class="settings-row__title">{t("githubConnections.details")}</summary>
          <div class="settings-subrows">
            <SettingsRow
              title={t("agentTools.githubEffectiveAuthor")}
              control={
                <SettingsValue
                  value={
                    [identity().gitAuthor.name, identity().gitAuthor.email]
                      .filter(Boolean)
                      .join(" · ") || t("agentTools.githubAuthorUnset")
                  }
                />
              }
            />
            <SettingsRow
              title={t("agentTools.githubEffectiveCredential")}
              control={
                <SettingsValue value={t(GITHUB_CREDENTIAL_KIND[identity().credentialKind])} />
              }
            />
            <Show when={identity().credentialKind === "managed-oauth"}>
              <SettingsRow
                title={t("agentTools.githubEffectiveAccessExpiry")}
                control={
                  <SettingsValue
                    value={
                      identity().accessExpiresAtMs
                        ? formatDateTimeMs(identity().accessExpiresAtMs!)
                        : t("common.na")
                    }
                  />
                }
              />
              <SettingsRow
                title={t("agentTools.githubEffectiveRefresh")}
                control={<SettingsValue value={t(GITHUB_REFRESH_STATE[identity().refreshState])} />}
              />
              <SettingsRow
                title={t("agentTools.githubEffectiveScopes")}
                control={
                  <SettingsValue value={identity().oauthScopes.join(", ") || t("common.none")} />
                }
              />
            </Show>
          </div>
        </details>
      )}
    </Show>
  );
}

function GitHubAuthorization(props: ControllerProps) {
  const authorization = () => props.controller.authorization;
  const code = () => {
    const state = authorization();
    return "userCode" in state ? state : undefined;
  };
  const starting = () =>
    authorization().phase === "starting" || (authorization().phase === "cancelling" && !code());
  const failed = () =>
    ["access_denied", "expired", "incorrect_device_code", "failed"].includes(authorization().phase);
  const failureDescription = () => {
    const state = authorization();
    return formatUiExternalText(
      state.phase === "expired"
        ? t("agentTools.githubExpired")
        : state.phase === "access_denied"
          ? t("agentTools.githubDenied")
          : state.phase === "incorrect_device_code"
            ? t("agentTools.githubIncorrectCode")
            : state.phase === "failed"
              ? (state.message ?? t("agentTools.githubAuthorizationFailed"))
              : t("agentTools.githubAuthorizationFailed"),
    );
  };
  const authorizeButton = () => (
    <button class="btn" onClick={() => void props.controller.startAuthorization()}>
      {t("githubConnections.continue")}
    </button>
  );
  const patButton = () => (
    <Show when={props.controller.scope !== "personal"}>
      <button class="btn" onClick={() => props.controller.showPatFallback()}>
        {t("agentTools.githubUsePat")}
      </button>
    </Show>
  );
  return (
    <Switch>
      <Match when={!props.controller.connectionReady}>
        <SettingsRow
          title={t("agentTools.githubConnection")}
          control={<SettingsStatus kind="muted" label={t("agentTools.githubDisconnected")} />}
        />
      </Match>
      <Match when={!props.controller.statusReadable}>
        <SettingsRow
          title={<SettingsStatus kind="danger" label={t("agentTools.githubAccessRequired")} />}
          description={t("agentTools.githubReadRequired")}
        />
      </Match>
      <Match when={!props.controller.authorizable}>
        <SettingsRow
          title={<SettingsStatus kind="warn" label={t("agentTools.githubAccessRequired")} />}
          description={t("agentTools.githubAdminRequired")}
        />
      </Match>
      <Match when={starting()}>
        <SettingsRow
          title={t("agentTools.githubAuthorization")}
          control={
            <>
              <SettingsStatus
                kind="accent"
                label={
                  authorization().phase === "cancelling"
                    ? t("agentTools.githubCancelling")
                    : t("agentTools.githubStarting")
                }
              />
              <Show when={authorization().phase === "starting"}>
                <button
                  class="btn btn--sm"
                  onClick={() => void props.controller.cancelAuthorization()}
                >
                  {t("common.cancel")}
                </button>
              </Show>
            </>
          }
        />
      </Match>
      <Match when={code()}>
        {(state) => (
          <GitHubAuthorizationCode controller={props.controller} authorization={state()} />
        )}
      </Match>
      <Match when={!props.controller.patVisible}>
        <SettingsRow
          title={
            failed() ? (
              <SettingsStatus kind="danger" label={t("agentTools.githubAuthorizationFailed")} />
            ) : (
              t("agentTools.githubAuthorization")
            )
          }
          description={failed() ? failureDescription() : t("agentTools.githubConnectHint")}
          control={
            <>
              {authorizeButton()}
              <Show when={failed()}>{patButton()}</Show>
            </>
          }
        />
        <Show when={!failed() && props.controller.scope !== "personal"}>
          <SettingsRow
            title={t("agentTools.githubPatFallback")}
            description={t("agentTools.githubPatFallbackHint")}
            control={patButton()}
          />
        </Show>
      </Match>
    </Switch>
  );
}

function GitHubAuthorizationCode(
  props: ControllerProps & {
    authorization: Extract<GitHubIdentityController["authorization"], { userCode: string }>;
  },
) {
  return (
    <>
      <SettingsRow
        title={t("agentTools.githubAuthorization")}
        description={
          props.authorization.phase === "cancel_error"
            ? `${t("agentTools.githubCancelFailedHint")}${props.authorization.message ? ` ${props.authorization.message}` : ""}`
            : t("agentTools.githubAuthorizationHint")
        }
        control={
          <>
            <SettingsStatus
              kind={
                props.authorization.phase === "network_error" ||
                props.authorization.phase === "cancel_error"
                  ? "warn"
                  : "accent"
              }
              label={t(
                props.authorization.phase === "pending" && props.authorization.slowedDown
                  ? "agentTools.githubSlowDown"
                  : GITHUB_AUTHORIZATION_LABEL[props.authorization.phase],
              )}
            />
            <a
              class="btn"
              href={props.authorization.verificationUri}
              target={EXTERNAL_LINK_TARGET}
              rel={buildExternalLinkRel()}
            >
              {t("agentTools.githubOpen")}
            </a>
          </>
        }
      />
      <SettingsRow
        title={t("agentTools.githubDeviceCode")}
        description={t("agentTools.githubDeviceCodeHint")}
        control={
          <>
            <code class="settings-row__value settings-row__value--mono github-device-code">
              {props.authorization.userCode}
            </code>
            <Show when={props.authorization.userCode} keyed>
              {(userCode) => (
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={(event) =>
                    void handleCopyButton(event, userCode, t("agentTools.githubCopyCode"))
                  }
                >
                  <Icon name="copy" />
                  <span data-copy-label>{t("agentTools.githubCopyCode")}</span>
                </button>
              )}
            </Show>
          </>
        }
      />
      <SettingsRow
        title={t("agentTools.githubExpires")}
        control={
          <SettingsValue
            value={formatDateTimeMs(props.authorization.displayExpiresAtMs, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          />
        }
      />
      <div class="settings-row settings-row--actions">
        <div class="settings-row__control">
          <Show
            when={
              props.authorization.phase !== "cancelling" &&
              props.authorization.phase !== "finishing"
            }
          >
            <button
              type="button"
              class="btn"
              onClick={() => void props.controller.cancelAuthorization()}
            >
              {props.authorization.phase === "cancel_error"
                ? t("agentTools.githubRetryCancel")
                : t("common.cancel")}
            </button>
          </Show>
        </div>
      </div>
    </>
  );
}

export function GitHubConnectionError(props: { error: string | null; control?: JSX.Element }) {
  return (
    <Show when={props.error}>
      <SettingsRow
        title={t("agentTools.githubErrorTitle")}
        description={<span role="alert">{formatUiExternalText(props.error!)}</span>}
        control={props.control}
      />
    </Show>
  );
}

export function GitHubConnectionSetup(props: ControllerProps) {
  const disabled = () =>
    props.controller.busy || !props.controller.configurable || props.controller.authorizationActive;
  const authorRow = (field: "name" | "email", label: string) => (
    <SettingsRow
      title={label}
      control={
        <input
          class="settings-input"
          aria-label={label}
          autocomplete="off"
          value={props.controller.draft[field]}
          disabled={disabled()}
          onInput={(event) => props.controller.setDraft(field, event.currentTarget.value)}
        />
      }
    />
  );
  return (
    <>
      <GitHubAuthorization controller={props.controller} />
      <Show when={props.controller.patVisible}>
        <div class="settings-subrows">
          <SettingsRow
            title={t("agentTools.githubToken")}
            description={t("agentTools.githubTokenDesc")}
            control={
              <SettingsSecretInput
                ariaLabel={t("agentTools.githubToken")}
                value={props.controller.draft.token}
                visible={props.controller.tokenRevealed}
                disabled={disabled()}
                showLabel={t("configForm.revealValue")}
                hideLabel={t("configForm.hideValue")}
                toggleLabel={t("agentTools.githubTokenToggle")}
                onInput={(value) => props.controller.setDraft("token", value)}
                onToggle={() => props.controller.toggleTokenVisibility()}
              />
            }
          />
          {authorRow("name", t("agentTools.githubAuthorName"))}
          {authorRow("email", t("agentTools.githubAuthorEmail"))}
          <div class="settings-row settings-row--actions">
            <div class="settings-row__control">
              <button
                class="btn"
                disabled={props.controller.busy}
                onClick={() => props.controller.hidePatFallback()}
              >
                {t("common.cancel")}
              </button>
              <button
                class="btn primary"
                disabled={disabled()}
                onClick={() => void props.controller.configure()}
              >
                {props.controller.busy ? t("common.saving") : t("agentTools.githubConfigure")}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}

export function GitHubIdentity(props: ControllerProps & { onOpenConnections: () => void }) {
  const identity = () => props.controller.status?.effective ?? null;
  return (
    <SettingsSection
      title={t("githubConnections.agentTitle")}
      description={t("githubConnections.agentDescription")}
      actions={
        <Show when={props.controller.statusReadable}>
          <button
            class="btn btn--sm"
            disabled={
              props.controller.loading ||
              props.controller.busy ||
              props.controller.authorizationActive
            }
            onClick={() => void props.controller.verify()}
          >
            {t("agentTools.githubVerify")}
          </button>
        </Show>
      }
    >
      <SettingsRow
        title={
          identity()?.account ? `@${identity()!.account!.login}` : t("agentTools.githubNoAccount")
        }
        description={
          identity()?.source === "agent-override"
            ? t("githubConnections.agentOverride")
            : t("githubConnections.system")
        }
        control={
          <>
            <GitHubHealth identity={identity()} request={props.controller} />
            <button class="btn btn--sm" onClick={() => props.onOpenConnections()}>
              {t("githubConnections.manageCommon")}
            </button>
          </>
        }
      />
      <GitHubConnectionError error={props.controller.error} />
      <Show when={props.controller.configurable}>
        <details class="settings-row settings-row--stacked">
          <summary class="settings-row__title">{t("githubConnections.advancedOverride")}</summary>
          <div class="settings-subrows">
            <SettingsRow
              title={t("githubConnections.agentOverride")}
              description={
                props.controller.status?.selected.configured
                  ? t("agentTools.githubConfiguredHere")
                  : t("agentTools.githubInheritedHere")
              }
            />
            <GitHubConnectionSetup controller={props.controller} />
            <Show when={props.controller.status?.selected.configured}>
              <SettingsRow
                title={t("agentTools.githubUseSystemNewRuns")}
                description={t("agentTools.githubAgentMutationHint")}
                control={
                  <button
                    class="btn"
                    disabled={props.controller.busy || props.controller.authorizationActive}
                    onClick={() => void props.controller.inherit()}
                  >
                    {t("agentTools.githubUseSystemNewRuns")}
                  </button>
                }
              />
            </Show>
          </div>
        </details>
      </Show>
      <GitHubDetails identity={identity()} />
    </SettingsSection>
  );
}

registerEnglishCatalog(registerGitHubEnglish);
