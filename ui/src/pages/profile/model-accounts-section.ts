import { html, nothing } from "lit";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { providerDisplayLabel, renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderPicker } from "../../components/select-picker.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";

registerModelAccountsEnglish();

type ModelAccountsContext = {
  gatewayUrl: string;
  personLabel: string | null;
  unavailableReason: "identity" | "write" | "profile";
  onConnectionSettings: () => void;
};

export type ModelAccountsSectionProps = {
  links: UserProfileAuthLink[];
  accounts: UserModelAccount[];
  hasMore: boolean;
  inventoryLoading: boolean;
  inventoryError: string | null;
  /** Linking an arbitrary stored credential is operator.admin-only server-side. */
  showManualLink: boolean;
  busy: boolean;
  cancelBusy: boolean;
  error: string | null;
  notice: string | null;
  statusUnavailable: boolean;
  linkDraft: string;
  signIn: {
    providers: UsersAuthConnectCatalogResult["providers"];
    provider: string;
    method: string;
  } | null;
  connectFlow: (UsersAuthConnectStartResult & { step?: WizardStep }) | null;
  stepValue: unknown;
  onLinkDraftInput: (value: string) => void;
  onLink: () => void;
  onUnlink: (provider: string) => void;
  onSelectAccount: (authProfileId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onAddAccount: () => void;
  onProviderChange: (provider: string) => void;
  onMethodChange: (method: string) => void;
  onCloseSignIn: () => void;
  onConnectStart: () => void;
  onStepValueChange: (stepId: string, value: unknown) => void;
  onStepAnswer: (stepId: string, value: unknown) => void;
  onConnectCancel: () => void;
  onConnectCheck: () => void;
};

function gatewayEndpoint(gatewayUrl: string): string {
  const url = URL.parse(gatewayUrl);
  return url ? `${url.origin}${url.pathname}` : t("profilePage.modelAccounts.gatewayUnavailable");
}

function accountIdDetail(accounts: UserModelAccount[], account: UserModelAccount) {
  return accounts.some(
    (candidate) =>
      candidate.authProfileId !== account.authProfileId &&
      candidate.provider === account.provider &&
      candidate.label === account.label,
  )
    ? html` <code>${account.authProfileId}</code>`
    : "";
}

function renderAccountRow(
  props: ModelAccountsSectionProps,
  row: { kind: "linked"; link: UserProfileAuthLink } | { kind: "saved"; account: UserModelAccount },
) {
  const linked = row.kind === "linked";
  const reference = row.kind === "linked" ? row.link : row.account;
  const account =
    row.kind === "linked"
      ? props.accounts.find((candidate) => candidate.authProfileId === row.link.authProfileId)
      : row.account;
  const label =
    row.kind === "linked"
      ? (account?.label ?? t("profilePage.modelAccounts.gatewayAccount"))
      : row.account.label;
  const provider = providerDisplayLabel(reference.provider);
  const action = t(
    linked ? "profilePage.modelAccounts.unlinkAction" : "profilePage.modelAccounts.selectAction",
  );
  return renderSettingsRow({
    title: html`
      <span class="model-accounts__id">${label}</span>
      <span class="model-accounts__provider">${provider}</span>
    `,
    description: html`${
      row.kind === "linked"
        ? t("profilePage.modelAccounts.linkedDescription")
        : t(`profilePage.modelAccounts.authTypes.${row.account.authType}`)
    }${account ? accountIdDetail(props.accounts, account) : ""}`,
    control: html`
      ${linked ? renderSettingsStatus({ kind: "ok", label: t("profilePage.modelAccounts.linkedStatus") }) : nothing}
      <button
        type="button"
        class="btn btn--sm ${linked ? "profile-auth-link-unlink" : "profile-auth-account-select"}"
        data-auth-profile-id=${linked ? nothing : reference.authProfileId}
        aria-label=${
          linked
            ? `${action}: ${provider} · ${account?.label ?? reference.authProfileId}`
            : `${action}: ${provider} · ${label} (${reference.authProfileId})`
        }
        ?disabled=${props.busy}
        @click=${() =>
          linked
            ? props.onUnlink(reference.provider)
            : props.onSelectAccount(reference.authProfileId)}
      >
        ${action}
      </button>
    `,
  });
}

function renderSignIn(props: ModelAccountsSectionProps) {
  const choice = props.signIn;
  if (!choice) {
    return "";
  }
  const provider = choice.providers.find((entry) => entry.id === choice.provider);
  const flow = props.connectFlow;
  const step = flow?.step;
  const cancel = html`<button
    type="button"
    class="btn btn--sm profile-auth-connect-cancel"
    ?disabled=${props.cancelBusy}
    @click=${flow ? props.onConnectCancel : props.onCloseSignIn}
  >
    ${t("profilePage.modelAccounts.cancelAction")}
  </button>`;
  return renderSettingsRow({
    title: flow
      ? (flow.step?.title ?? provider?.label ?? t("profilePage.modelAccounts.connectAction"))
      : t("profilePage.modelAccounts.addAccount"),
    stacked: true,
    control: flow
      ? html`<div class="model-accounts-flow">
          ${
            step
              ? renderWizardStepControls({
                  step,
                  value: props.stepValue,
                  busy: props.busy,
                  inputId: "profile-account-auth-answer",
                  leadingAction: cancel,
                  onValueChange: (value) => props.onStepValueChange(step.id, value),
                  onAnswer: (value) => props.onStepAnswer(step.id, value),
                })
              : html`<span role="status">${t("common.loading")}</span>${cancel}`
          }
          ${
            props.statusUnavailable
              ? html`<button
                  type="button"
                  class="btn btn--sm profile-auth-connect-check"
                  ?disabled=${props.cancelBusy}
                  @click=${props.onConnectCheck}
                >
                  ${t("profilePage.modelAccounts.checkStatusAction")}
                </button>`
              : ""
          }
        </div>`
      : html`<div class="model-accounts-choice">
          ${renderPicker({
            label: t("profilePage.modelAccounts.provider"),
            className: "profile-auth-provider",
            value: choice.provider || null,
            options: choice.providers.map((entry) => ({ value: entry.id, label: entry.label })),
            disabled: props.busy,
            renderLeading: (entry) => renderProviderBrandIcon(entry.value),
            onChange: props.onProviderChange,
          })}
          ${
            provider
              ? renderPicker({
                  label: t("profilePage.modelAccounts.method"),
                  className: "profile-auth-method",
                  value: choice.method || null,
                  options: provider.methods.map((method) => ({
                    value: method.id,
                    label: method.label,
                    description: method.hint,
                  })),
                  disabled: props.busy,
                  onChange: props.onMethodChange,
                })
              : ""
          }
          ${
            !props.busy && !props.error && choice.providers.length === 0
              ? html`<span>${t("profilePage.modelAccounts.noMethods")}</span>`
              : ""
          }
          <div class="wizard-step__actions">
            ${cancel}
            <button
              type="button"
              class="btn btn--sm primary profile-auth-connect-start"
              ?disabled=${props.busy || !choice.method}
              @click=${props.onConnectStart}
            >
              ${t("profilePage.modelAccounts.connectAction")}
            </button>
          </div>
        </div>`,
  });
}

function renderManualLinkRow(props: ModelAccountsSectionProps) {
  return renderSettingsRow({
    title: t("profilePage.modelAccounts.inputLabel"),
    description: t("profilePage.modelAccounts.inputDescription"),
    stackedOnNarrow: true,
    control: html`
      <form
        class="model-accounts-form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onLink();
        }}
      >
        <input
          class="settings-input profile-auth-link-input"
          type="text"
          aria-label=${t("profilePage.modelAccounts.inputLabel")}
          .value=${props.linkDraft}
          placeholder=${t("profilePage.modelAccounts.inputPlaceholder")}
          ?disabled=${props.busy}
          @input=${(event: Event) =>
            // SAFETY: This listener is bound to the native text input above.
            props.onLinkDraftInput((event.target as HTMLInputElement).value)}
        />
        <button
          type="submit"
          class="btn btn--sm profile-auth-link-submit"
          ?disabled=${props.busy || !props.linkDraft.trim()}
        >
          ${t("profilePage.modelAccounts.linkAction")}
        </button>
      </form>
    `,
  });
}

function renderModelAccountRows(props: ModelAccountsSectionProps) {
  return html`
    ${
      props.links.length === 0
        ? renderSettingsEmpty(t("profilePage.modelAccounts.empty"))
        : props.links.map((link) => renderAccountRow(props, { kind: "linked", link }))
    }
    ${props.accounts
      .filter((account) => !account.selected)
      .map((account) => renderAccountRow(props, { kind: "saved", account }))}
    ${
      props.hasMore
        ? renderSettingsRow({
            title: t("profilePage.modelAccounts.savedAccounts"),
            control: html`<button
              type="button"
              class="btn btn--sm profile-auth-accounts-more"
              ?disabled=${props.busy}
              @click=${props.onLoadMore}
            >
              ${t("profilePage.modelAccounts.loadMore")}
            </button>`,
          })
        : ""
    }
    ${renderSignIn(props)} ${props.showManualLink ? renderManualLinkRow(props) : ""}
    ${(["notice", "error"] as const).map((kind) =>
      props[kind]
        ? html`<div
            class="settings-row model-accounts-${kind}"
            role=${kind === "notice" ? "status" : "alert"}
          >
            <span class="settings-row__desc">${props[kind]}</span>
          </div>`
        : "",
    )}
    ${
      props.inventoryError
        ? html`<div class="settings-row model-accounts-error" role="alert">
            ${t("profilePage.modelAccounts.inventoryFailed")} ${props.inventoryError}
          </div>`
        : ""
    }
  `;
}

export function renderModelAccountsSection(
  context: ModelAccountsContext,
  props: ModelAccountsSectionProps | null,
) {
  const rows = html`
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.gateway"),
      stackedOnNarrow: true,
      control: renderSettingsValue(gatewayEndpoint(context.gatewayUrl), { mono: true }),
    })}
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.person"),
      stackedOnNarrow: true,
      control: renderSettingsValue(context.personLabel ?? t("profilePage.modelAccounts.noPerson")),
    })}
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.scope"),
      description: t("profilePage.modelAccounts.personalDescription"),
      control: renderSettingsValue(t("profilePage.modelAccounts.personal")),
    })}
    ${
      props
        ? renderModelAccountRows(props)
        : renderSettingsRow({
            title: t("profilePage.modelAccounts.signInUnavailable"),
            description: t(`profilePage.modelAccounts.unavailable.${context.unavailableReason}`),
            stacked: true,
            control: html`
              <button type="button" class="btn btn--sm" @click=${context.onConnectionSettings}>
                ${t("profilePage.modelAccounts.connectionSettings")}
              </button>
              ${renderLearnMoreLink(
                "https://docs.openclaw.ai/concepts/multi-user#per-person-model-accounts",
              )}
            `,
          })
    }
  `;
  return renderSettingsSection(
    {
      title: t("profilePage.modelAccounts.title"),
      description: t("profilePage.modelAccounts.description"),
      actions: props
        ? html`${
              !props.signIn
                ? html`<button
                    type="button"
                    class="btn btn--sm primary profile-auth-add-account"
                    ?disabled=${props.busy}
                    @click=${props.onAddAccount}
                  >
                    ${t("profilePage.modelAccounts.addAccount")}
                  </button>`
                : ""
            }<button
              type="button"
              class="btn btn--sm profile-auth-accounts-refresh"
              ?disabled=${props.inventoryLoading}
              @click=${props.onRefresh}
            >
              ${t("common.refresh")}
            </button>`
        : undefined,
    },
    rows,
  );
}
