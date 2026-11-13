import type { JSX } from "@solidjs/web";
import { createMemo, Errored, isPending, latest, Loading, Match, Show, Switch } from "solid-js";
import type { GitHubIdentityFacts } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { ErrorDetails } from "../../components/config-error.tsx";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsDetailsRow } from "../../components/solid/settings-disclosure.tsx";
import {
  SettingsRow,
  SettingsSecretInput,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerGitHubConnectionsEnglish } from "../../i18n/locales/en-github-connections.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import type { GitHubIdentityView as GitHubIdentityModel } from "../../lib/reactive/domain-github-identity.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

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
  "app-installation": "agentTools.githubKindAppInstallation",
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

type RequestStatus = Pick<ReturnType<GitHubIdentityModel["read"]>, "statusCompletion">;
type IdentityProps = { identity: GitHubIdentityModel };

export function GitHubUnloadedStatus(props: { request: RequestStatus }) {
  const completed = createMemo(() => props.request.statusCompletion);
  return (
    <Errored
      fallback={(_error) => (
        <SettingsStatus
          kind={isPending(() => completed()) ? "muted" : "warn"}
          label={
            isPending(() => completed())
              ? t("githubConnections.checking")
              : t("githubConnections.statusUnavailable")
          }
        />
      )}
    >
      <Loading
        on={props.request.statusCompletion}
        fallback={<SettingsStatus kind="muted" label={t("githubConnections.checking")} />}
      >
        <Show when={completed() === undefined}>
          <SettingsStatus kind="muted" label={t("githubConnections.notLoaded")} />
        </Show>
      </Loading>
    </Errored>
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

/** Connection facts for one GitHub account, opened from that account's row. */
export function GitHubDetails(props: { identity: GitHubIdentityFacts | null }) {
  return (
    <Show when={props.identity}>
      {(identity) => (
        <>
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
            control={<SettingsValue value={t(GITHUB_CREDENTIAL_KIND[identity().credentialKind])} />}
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
        </>
      )}
    </Show>
  );
}

function GitHubAuthorization(props: IdentityProps) {
  const view = () => props.identity.read();
  const authorization = () => view().authorization;
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
            : "",
    );
  };
  const failureDetail = () => {
    const state = authorization();
    return state.phase === "failed" ? state.message : undefined;
  };
  const patButton = () => (
    <Show when={view().scope !== "personal"}>
      <button class="btn btn--sm" onClick={() => props.identity.showPatFallback()}>
        {t("agentTools.githubUsePat")}
      </button>
    </Show>
  );
  return (
    <Switch>
      <Match when={!view().connectionReady}>
        <SettingsRow
          title={t("agentTools.githubConnection")}
          control={<SettingsStatus kind="muted" label={t("agentTools.githubDisconnected")} />}
        />
      </Match>
      <Match when={!view().statusReadable}>
        <SettingsRow
          title={<SettingsStatus kind="danger" label={t("agentTools.githubAccessRequired")} />}
          description={t(
            view().scope === "personal"
              ? "agentTools.githubReadRequired"
              : "agentTools.githubAdminRequired",
          )}
        />
      </Match>
      <Match when={!view().authorizable}>
        <SettingsRow
          title={<SettingsStatus kind="warn" label={t("agentTools.githubAccessRequired")} />}
          description={t(
            view().scope === "personal"
              ? "agentTools.githubPersonalSignInRequired"
              : "agentTools.githubAdminRequired",
          )}
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
                  onClick={() => void props.identity.cancelAuthorization()}
                >
                  {t("common.cancel")}
                </button>
              </Show>
            </>
          }
        />
      </Match>
      <Match when={code()}>
        {(state) => <GitHubAuthorizationCode identity={props.identity} authorization={state()} />}
      </Match>
      <Match when={!view().patVisible}>
        <SettingsRow
          title={
            failed() ? (
              <SettingsStatus kind="danger" label={t("agentTools.githubAuthorizationFailed")} />
            ) : (
              t("agentTools.githubAuthorization")
            )
          }
          description={
            failed() ? (
              <>
                <Show when={failureDescription()}>
                  {(description) => <div>{description()}</div>}
                </Show>
                <ErrorDetails error={failureDetail()} />
              </>
            ) : (
              t("agentTools.githubConnectHint")
            )
          }
          control={
            <>
              <button class="btn btn--sm" onClick={() => void props.identity.startAuthorization()}>
                {t("githubConnections.continue")}
              </button>
              <Show when={failed()}>{patButton()}</Show>
            </>
          }
        />
        <Show when={!failed() && view().scope !== "personal"}>
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
  props: IdentityProps & {
    authorization: Extract<
      ReturnType<GitHubIdentityModel["read"]>["authorization"],
      { userCode: string }
    >;
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
              class="btn btn--sm"
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
              {(userCode) => {
                let label!: HTMLSpanElement;
                let announcement!: HTMLSpanElement;
                return (
                  <>
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={(event) =>
                        void handleCopyButton(event, userCode, t("agentTools.githubCopyCode"), {
                          label,
                          announcement,
                        })
                      }
                    >
                      <Icon name="copy" />
                      <span ref={(element) => (label = element)} data-copy-label>
                        {t("agentTools.githubCopyCode")}
                      </span>
                    </button>
                    <span
                      ref={(element) => (announcement = element)}
                      class="sr-only"
                      role="status"
                    />
                  </>
                );
              }}
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
              class="btn btn--sm"
              onClick={() => void props.identity.cancelAuthorization()}
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

function ConnectionErrorRow(props: { error: string | null; control?: JSX.Element }) {
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

export function GitHubConnectionError(props: {
  error: string | null;
  completion?: Promise<void>;
  secondaryCompletion?: Promise<void>;
  control?: JSX.Element;
}) {
  const completed = createMemo(() =>
    props.secondaryCompletion
      ? Promise.all([props.completion, props.secondaryCompletion]).then(() => undefined)
      : props.completion,
  );
  return (
    <Show
      when={props.error}
      fallback={
        <Errored
          fallback={(error) => (
            <ConnectionErrorRow error={formatUiError(error())} control={props.control} />
          )}
        >
          <Loading on={latest(() => [props.completion, props.secondaryCompletion])} fallback={null}>
            <Show when={completed() === undefined}>{null}</Show>
          </Loading>
        </Errored>
      }
    >
      <ConnectionErrorRow error={props.error} control={props.control} />
    </Show>
  );
}

export function GitHubConnectionSetup(props: IdentityProps & { saveLabel?: string }) {
  const view = () => props.identity.read();
  const disabled = () =>
    props.identity.saving() ||
    !view().connectionReady ||
    !view().configurable ||
    view().authorizationActive;
  const authorRow = (field: "name" | "email", label: string) => (
    <SettingsRow
      title={label}
      control={
        <input
          class="settings-input"
          aria-label={label}
          autocomplete="off"
          value={view().draft[field]}
          disabled={disabled()}
          onInput={(event) => props.identity.setDraft(field, event.currentTarget.value)}
        />
      }
    />
  );
  return (
    <>
      <GitHubAuthorization identity={props.identity} />
      <Show when={view().patVisible}>
        <div class="settings-subrows">
          <SettingsRow
            title={t("agentTools.githubToken")}
            description={t("agentTools.githubTokenDesc")}
            control={
              <SettingsSecretInput
                ariaLabel={t("agentTools.githubToken")}
                value={view().draft.token}
                visible={view().tokenRevealed}
                disabled={disabled()}
                showLabel={t("configForm.revealValue")}
                hideLabel={t("configForm.hideValue")}
                toggleLabel={t("agentTools.githubTokenToggle")}
                onInput={(value) => props.identity.setDraft("token", value)}
                onToggle={() => props.identity.toggleTokenVisibility()}
              />
            }
          />
          {authorRow("name", t("agentTools.githubAuthorName"))}
          {authorRow("email", t("agentTools.githubAuthorEmail"))}
          <div class="settings-row settings-row--actions">
            <div class="settings-row__control">
              <button
                class="btn"
                disabled={props.identity.saving()}
                onClick={() => props.identity.hidePatFallback()}
              >
                {t("common.cancel")}
              </button>
              <button
                class="btn primary"
                disabled={disabled()}
                onClick={() => void props.identity.configure()}
              >
                {props.identity.saving()
                  ? t("common.saving")
                  : (props.saveLabel ?? t("agentTools.githubConfigure"))}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}

export function GitHubIdentity(props: IdentityProps & { onOpenConnections: () => void }) {
  const view = () => props.identity.read();
  const identity = () => view().status?.effective ?? null;
  return (
    <openclaw-github-identity style={{ display: "contents" }}>
      <SettingsSection
        title={t("githubConnections.agentTitle")}
        description={t("githubConnections.agentDescription")}
        actions={
          <Show when={view().statusReadable}>
            <button
              class="btn btn--sm"
              disabled={view().loading || view().busy || view().authorizationActive}
              onClick={() => void props.identity.verify()}
            >
              {t("agentTools.githubVerify")}
            </button>
          </Show>
        }
      >
        <SettingsDetailsRow
          detailsLabel={t("githubConnections.details")}
          hasDetails={identity() !== null}
          title={
            identity() ? (
              identity()!.account ? (
                "@" + identity()!.account!.login
              ) : (
                t("agentTools.githubNoAccount")
              )
            ) : (
              <GitHubUnloadedStatus request={view()} />
            )
          }
          description={
            identity()
              ? identity()!.source === "agent-override"
                ? t("githubConnections.ownAccount")
                : t("githubConnections.usesShared")
              : undefined
          }
          control={
            <>
              <Show when={identity()}>
                <GitHubHealth identity={identity()} request={view()} />
              </Show>
              <button class="btn btn--sm" onClick={() => props.onOpenConnections()}>
                {t("githubConnections.manageCommon")}
              </button>
            </>
          }
        >
          <GitHubDetails identity={identity()} />
        </SettingsDetailsRow>
        <GitHubConnectionError error={view().error} completion={view().completion} />
      </SettingsSection>
    </openclaw-github-identity>
  );
}

registerEnglishCatalog(registerGitHubConnectionsEnglish);
