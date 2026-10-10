import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListAuthLinksResult,
  UsersListModelAccountsResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { modelAuthEventInvalidates } from "../../lib/model-auth-request-state.ts";
import { projectGateway, projectGatewayEvents } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { ModelAccountsSection, type ModelAccountsSectionProps } from "./model-accounts-section.tsx";

registerEnglishCatalog(registerModelAccountsEnglish);

type AccountTarget = {
  client: GatewayBrowserClient;
  identityId: string;
  profileId: string;
  canAdmin: boolean;
};
type AccountAction = "request" | "answer" | "cancel";

/** Model-account actions belong to the connection, not the profile editor's refresh cycle. */
class ModelAccountsState {
  links: UserProfileAuthLink[] = [];
  accounts: UserModelAccount[] = [];
  nextCursor: string | undefined;
  inventoryLoading = false;
  inventoryError: string | null = null;
  action: AccountAction | null = null;
  error: string | null = null;
  notice: "connected" | "cancelled" | "expired" | "selected" | "cleared" | null = null;
  linkDraft = "";
  signIn: ModelAccountsSectionProps["signIn"] = null;
  connectFlow: ModelAccountsSectionProps["connectFlow"] = null;
  stepValue: unknown;
  statusUnavailable = false;

  target: AccountTarget | null = null;
  generation = 0;
  inventoryRequest = 0;
  pollTimer: ReturnType<typeof setTimeout> | null = null;
  connected = true;
  constructor(
    readonly context: ApplicationContext,
    readonly props: ModelAccountsProps,
    readonly publish: () => void,
  ) {}
  dispose() {
    this.connected = false;
    this.generation += 1;
    this.target = null;
    this.stopPoll();
  }

  applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const canWrite =
      snapshot.phase === "connected" && hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    const client = canWrite ? snapshot.client : null;
    const identityId = snapshot.selfUser?.id ?? null;
    // users.self returns canonical IDs while presence may still name a merged alias.
    // Bind the parent's canonical result to its exact authenticated connection identity.
    const profileId = client && identityId === this.props.identityId ? this.props.profileId : null;
    const canAdmin = canWrite && hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (
      this.target?.client === client &&
      this.target?.identityId === identityId &&
      this.target?.profileId === profileId &&
      this.target?.canAdmin === canAdmin
    ) {
      return;
    }
    this.generation += 1;
    this.stopPoll();
    this.target =
      client && identityId && profileId ? { client, identityId, profileId, canAdmin } : null;
    this.links = [];
    this.accounts = [];
    this.nextCursor = undefined;
    this.inventoryRequest += 1;
    this.inventoryLoading = false;
    this.inventoryError = null;
    this.action = null;
    this.error = null;
    this.notice = null;
    this.linkDraft = "";
    this.signIn = null;
    this.connectFlow = null;
    this.stepValue = undefined;
    this.statusUnavailable = false;
    this.publish();
    if (this.target) {
      void this.loadAccounts();
    }
  }

  applyLinks(links: UserProfileAuthLink[]) {
    this.links = links;
    this.accounts = this.accounts.map((account) => ({
      ...account,
      selected: links.some((link) => link.authProfileId === account.authProfileId),
    }));
  }

  async loadAccounts(cursor?: string) {
    const target = this.target;
    if (!target) {
      return;
    }
    const request = ++this.inventoryRequest;
    const isCurrent = () =>
      this.connected && this.target === target && request === this.inventoryRequest;
    this.inventoryLoading = true;
    this.inventoryError = null;
    this.publish();
    try {
      const result = await target.client.request<UsersListModelAccountsResult>(
        "users.listModelAccounts",
        { profileId: target.profileId, ...(cursor ? { cursor } : {}) },
      );
      if (isCurrent()) {
        this.accounts = cursor ? [...this.accounts, ...result.accounts] : result.accounts;
        this.nextCursor = result.nextCursor;
        this.applyLinks(result.links);
      }
    } catch (error) {
      if (isCurrent()) {
        this.inventoryError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.inventoryLoading = false;
        this.publish();
      }
    }
  }

  isCurrent(target: AccountTarget, generation: number) {
    return this.connected && this.target === target && this.generation === generation;
  }

  async runAction<T>(
    action: AccountAction,
    request: (target: AccountTarget) => Promise<T>,
    apply: (result: T) => void,
  ) {
    const target = this.target;
    if (!target || (this.action && !(action === "cancel" && this.action === "answer"))) {
      return;
    }
    const generation = ++this.generation;
    this.stopPoll();
    this.action = action;
    this.error = null;
    this.notice = null;
    this.statusUnavailable = false;
    this.publish();
    try {
      const result = await request(target);
      if (this.isCurrent(target, generation)) {
        apply(result);
      }
    } catch (error) {
      if (this.isCurrent(target, generation)) {
        this.error = formatUiError(error, t("profilePage.modelAccounts.actionFailed"));
      }
    } finally {
      if (this.isCurrent(target, generation)) {
        this.action = null;
        this.schedulePoll(this.connectFlow?.step ? 2000 : 0);
        this.publish();
      }
    }
  }

  updateAccount(action: "link" | "unlink" | "select", value: string) {
    if (action === "link" && (!value || !this.target?.canAdmin)) {
      return;
    }
    const methods = {
      link: "users.linkAuthProfile",
      unlink: "users.unlinkAuthProfile",
      select: "users.selectModelAccount",
    };
    void this.runAction(
      "request",
      (target) =>
        target.client.request<UsersListAuthLinksResult>(methods[action], {
          profileId: target.profileId,
          ...(action === "unlink" ? { provider: value } : { authProfileId: value }),
        }),
      (result) => {
        this.applyLinks(result.links);
        if (action !== "select") {
          this.linkDraft = "";
        }
        this.notice = action === "unlink" ? "cleared" : "selected";
        void this.loadAccounts();
      },
    );
  }

  openSignIn() {
    this.signIn = { providers: [], provider: "", method: "" };
    void this.runAction(
      "request",
      (target) =>
        target.client.request<UsersAuthConnectCatalogResult>("users.authConnect.catalog", {
          profileId: target.profileId,
        }),
      (result) => {
        this.signIn = { providers: result.providers, provider: "", method: "" };
      },
    );
  }

  selectProvider(provider: string) {
    const choice = this.signIn;
    const entry = choice?.providers.find((candidate) => candidate.id === provider);
    if (choice && entry && !this.action && !this.connectFlow) {
      this.signIn = {
        ...choice,
        provider,
        method: entry.methods.length === 1 ? (entry.methods[0]?.id ?? "") : "",
      };
      this.publish();
    }
  }

  startConnect() {
    const choice = this.signIn;
    if (
      !choice?.providers.some(
        (provider) =>
          provider.id === choice.provider &&
          provider.methods.some((method) => method.id === choice.method),
      )
    ) {
      return;
    }
    void this.runAction(
      "request",
      (target) =>
        target.client.request<UsersAuthConnectStartResult>("users.authConnect.start", {
          profileId: target.profileId,
          provider: choice.provider,
          method: choice.method,
        }),
      (result) => {
        this.connectFlow = result;
        this.stepValue = undefined;
      },
    );
  }

  applyConnectStatus(result: UsersAuthConnectStatusResult) {
    if (result.status === "pending") {
      if (result.error) {
        this.error = formatUiError(result.error);
      }
      if (this.connectFlow) {
        if (this.connectFlow.step?.id !== result.step?.id) {
          this.stepValue = result.step?.sensitive ? undefined : result.step?.initialValue;
        }
        this.connectFlow = { ...this.connectFlow, step: result.step };
      }
      return;
    }
    this.error = null;
    this.statusUnavailable = false;
    this.stopPoll();
    this.signIn = null;
    this.connectFlow = null;
    this.stepValue = undefined;
    if (result.status === "failed") {
      this.error = t(`profilePage.modelAccounts.connectErrors.${result.reason}`);
      return;
    }
    if (result.status === "connected") {
      this.applyLinks(result.links);
      void this.loadAccounts();
    }
    this.notice = result.status;
  }

  connectStatus(action: "cancel" | "status") {
    const flow = this.connectFlow;
    if (!flow) {
      return;
    }
    void this.runAction(
      action === "status" ? "request" : action,
      (target) =>
        target.client.request<UsersAuthConnectStatusResult>(`users.authConnect.${action}`, {
          profileId: target.profileId,
          connectId: flow.connectId,
        }),
      (result) => this.applyConnectStatus(result),
    );
  }

  answerStep(stepId: string, value: unknown) {
    const flow = this.connectFlow;
    const step = flow?.step;
    if (!flow || !step || step.id !== stepId || step.type === "progress") {
      return;
    }
    // Do not retain submitted secrets while the Gateway runs the provider-owned step.
    if (step.sensitive) {
      this.stepValue = undefined;
    }
    void this.runAction(
      "answer",
      (target) =>
        target.client.request<UsersAuthConnectStatusResult>("users.authConnect.answer", {
          profileId: target.profileId,
          connectId: flow.connectId,
          stepId: step.id,
          ...(value !== undefined ? { value } : {}),
        }),
      (result) => this.applyConnectStatus(result),
    );
  }

  stopPoll() {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  schedulePoll(interval = 2000) {
    this.stopPoll();
    const flow = this.connectFlow;
    if (!flow || !this.target || this.action) {
      return;
    }
    const delay = Math.max(0, Math.min(interval, flow.expiresAtMs - Date.now()));
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollStatus();
    }, delay);
  }

  async pollStatus() {
    const target = this.target;
    const flow = this.connectFlow;
    const generation = this.generation;
    if (!target || !flow || this.action) {
      return;
    }
    try {
      const result = await target.client.request<UsersAuthConnectStatusResult>(
        "users.authConnect.status",
        {
          profileId: target.profileId,
          connectId: flow.connectId,
        },
      );
      if (!this.isCurrent(target, generation) || this.connectFlow?.connectId !== flow.connectId) {
        return;
      }
      this.applyConnectStatus(result);
      this.publish();
      if (this.connectFlow) {
        // Poll serially and only through the server deadline. If clocks disagree,
        // leave the attempt cancellable instead of inventing an expiry outcome.
        if (Date.now() >= flow.expiresAtMs) {
          this.statusUnavailable = true;
          this.error = t("profilePage.modelAccounts.statusTimedOut");
          this.publish();
        } else {
          this.schedulePoll();
        }
      }
    } catch (error) {
      if (this.isCurrent(target, generation)) {
        this.statusUnavailable = true;
        this.error = formatUiError(error, t("profilePage.modelAccounts.statusFailed"));
        this.publish();
      }
    }
  }

  section() {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.phase !== "connected" || !snapshot.client) {
      return null;
    }
    const person = snapshot.selfUser?.id === this.props.identityId ? snapshot.selfUser : null;
    const section: Parameters<typeof ModelAccountsSection>[0] = {
      context: {
        gatewayUrl: (this.target?.client ?? snapshot.client).gatewayUrl,
        personLabel: person
          ? this.props.personLabel ||
            person.name ||
            person.email ||
            t("profilePage.modelAccounts.currentPerson")
          : null,
        unavailableReason: !person
          ? "identity"
          : hasOperatorWriteAccess(snapshot.hello?.auth ?? null)
            ? "profile"
            : "write",
        onConnectionSettings: () => this.context.navigate("connection"),
      },
      state: this.target
        ? {
            links: this.links,
            accounts: this.accounts,
            hasMore: Boolean(this.nextCursor),
            inventoryLoading: this.inventoryLoading,
            inventoryError: this.inventoryError,
            showManualLink: this.target.canAdmin,
            busy: this.inventoryLoading || this.action !== null,
            cancelBusy: this.action !== null && this.action !== "answer",
            error: this.error,
            notice: this.notice ? t(`profilePage.modelAccounts.notices.${this.notice}`) : null,
            statusUnavailable: this.statusUnavailable,
            linkDraft: this.linkDraft,
            signIn: this.signIn,
            connectFlow: this.connectFlow,
            stepValue: this.stepValue,
            onLinkDraftInput: (value) => {
              this.linkDraft = value;
              this.publish();
            },
            onLink: () => this.updateAccount("link", this.linkDraft.trim()),
            onUnlink: (provider) => this.updateAccount("unlink", provider),
            onSelectAccount: (authProfileId) => this.updateAccount("select", authProfileId),
            onLoadMore: () => void this.loadAccounts(this.nextCursor),
            onRefresh: () => void this.loadAccounts(),
            onAddAccount: () => this.openSignIn(),
            onProviderChange: (provider) => this.selectProvider(provider),
            onMethodChange: (method) => {
              if (this.signIn && !this.action && !this.connectFlow) {
                this.signIn = { ...this.signIn, method };
                this.publish();
              }
            },
            onCloseSignIn: () => {
              if (!this.action && !this.connectFlow) {
                this.signIn = null;
                this.error = null;
                this.publish();
              }
            },
            onConnectStart: () => this.startConnect(),
            onStepValueChange: (stepId, value) => {
              if (this.connectFlow?.step?.id === stepId) {
                this.stepValue = value;
                this.publish();
              }
            },
            onStepAnswer: (stepId, value) => this.answerStep(stepId, value),
            onConnectCancel: () => this.connectStatus("cancel"),
            onConnectCheck: () => this.connectStatus("status"),
          }
        : null,
    };
    return section;
  }
}

export type ModelAccountsProps = {
  identityId?: string | null;
  profileId?: string | null;
  personLabel?: string | null;
};

function ModelAccountsContent(props: ModelAccountsProps) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new ModelAccountsState(context, props, () => setRevision((value) => value + 1));
  const gateway = projectGateway(context.gateway);
  const events = projectGatewayEvents(context.gateway);
  const sync = () => {
    state.applySnapshot(gateway.read().snapshot);
    state.publish();
  };
  const stopGateway = gateway.subscribe(sync);
  const stopEvents = events.subscribe((event) => {
    if (modelAuthEventInvalidates(event)) {
      void state.loadAccounts();
    }
  });
  createEffect(() => [props.identityId, props.profileId], sync);
  sync();
  const section = () => {
    revision();
    return state.section();
  };
  onCleanup(() => {
    stopEvents();
    stopGateway();
    state.dispose();
  });
  return (
    <Show when={section()}>
      {(data) => <ModelAccountsSection context={data().context} state={data().state} />}
    </Show>
  );
}

export const ModelAccounts = defineSolidBridge("openclaw-model-accounts", ModelAccountsContent, {
  properties: {
    identityId: { default: null, attribute: false },
    profileId: { default: null, attribute: false },
    personLabel: { default: null, attribute: false },
  },
});
