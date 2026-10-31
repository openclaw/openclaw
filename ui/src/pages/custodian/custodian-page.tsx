import type {
  SystemChangesListResult,
  UserProfile,
  UsersSetDisplayNameResult,
} from "@openclaw/gateway-protocol";
import {
  createMemo,
  createSignal,
  Errored,
  isPending,
  latest,
  lazy,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import "../../components/openclaw-mascot.tsx";
import type { SidebarAttentionElementAttributes } from "../../components/sidebar-attention-element.ts";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import {
  channelSnapshotHasActiveChannel,
  createChannelCapability,
} from "../../lib/channels/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectChannels } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import "../../styles/custodian.css";
import { createCustodianActions } from "./custodian-actions.ts";
import { CustodianChangeHistory, type HistorySnapshot } from "./custodian-history.tsx";
import { CustodianChannelOnboardingNudge } from "./custodian-nudge.tsx";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import { CustodianSurface } from "./custodian-surface.tsx";
import type { CustodianRouteData } from "./route.tsx";

type OnboardingIdentityOwner = {
  client: GatewayBrowserClient;
  connectionRevision: number;
  gatewayUrl: string;
  recoveryScope: string | null;
  selfUserId: string | null;
  selfUserProfileId: string | null;
};

type Props = { onboarding: boolean; newAgentIntent: boolean; store: CustodianSessionStore };
const SidebarAttention = lazy(() => import("../../components/sidebar-attention.tsx"), {
  export: "SidebarAttention",
});
const propertyReceipts = new WeakMap<HTMLElement, (key: keyof Props) => void>();
function CustodianPageContent(props: Props, host: SolidBridgeElement<Props>) {
  const context = useApplication();
  const channelCapability = context.acquireChannels(createChannelCapability);
  const gateway = projectGateway(context.gateway);
  const channels = projectChannels(channelCapability);
  const store = projectOwner(host.store, (source) => source);
  const presentation = createCustodianActions(() => host.store);
  const historyAvailable = createMemo(() => {
    const snapshot = gateway.read().snapshot;
    return (
      snapshot.phase === "connected" &&
      snapshot.client !== null &&
      isGatewayMethodAdvertised(snapshot, "openclaw.changes.list") === true
    );
  });
  const historyConnection = createMemo(
    () => [gateway.read().snapshot.client, historyAvailable()] as const,
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  const historyOwner = createMemo<{
    connection: ReturnType<typeof historyConnection>;
    busy: boolean;
    snapshot: HistorySnapshot;
  }>(() => ({
    connection: historyConnection(),
    busy: false,
    snapshot: { entries: [], nextCursor: null, error: null, loaded: false },
  }));
  // History drafts reset with the connection; local requests share its synchronous admission state.
  const [historyOpen, setHistoryOpen] = createSignal(() => {
    historyConnection();
    return false;
  });
  const [historyReceipt, setHistoryReceipt] = createSignal<{
    owner: ReturnType<typeof historyOwner>;
    reset: boolean;
    result: Promise<HistorySnapshot>;
  } | null>(() => {
    historyOwner();
    return null;
  });
  let disposed = false;
  const [onboardingNameProfile, setOnboardingNameProfile] = createSignal<UserProfile | null>(null);
  const [onboardingNameDraft, setOnboardingNameDraft] = createSignal("");
  const [onboardingNameLoading, setOnboardingNameLoading] = createSignal(true);
  const [onboardingNameBusy, setOnboardingNameBusy] = createSignal(false);
  const [onboardingNameError, setOnboardingNameError] = createSignal<string | null>(null);
  const [onboardingNameSkipped, setOnboardingNameSkipped] = createSignal(false);
  let onboardingOwner: OnboardingIdentityOwner | null = null;
  let onboardingNameRequestEpoch = 0;
  let onboardingDisplayObservation: {
    userId: string | null;
    profileId: string | null;
    name: string | null | undefined;
  } | null = null;
  let onboardingDisplayObservationRevision = 0;
  let onboardingLoadPending = false;
  let onboardingSavePending = false;
  function observeOnboardingDisplayName(): void {
    const selfUser = context.gateway.snapshot.selfUser;
    const observation = {
      userId: selfUser?.id ?? null,
      profileId: selfUser?.identity?.id ?? null,
      name: selfUser?.name,
    };
    const previous = onboardingDisplayObservation;
    if (
      previous &&
      previous.userId === observation.userId &&
      previous.profileId === observation.profileId &&
      previous.name !== observation.name
    ) {
      onboardingDisplayObservationRevision += 1;
    }
    onboardingDisplayObservation = observation;
  }
  function currentOnboardingOwner(): OnboardingIdentityOwner | null {
    const gatewayOwner = context.gateway;
    const snapshot = gatewayOwner.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    if (!host.onboarding || !client || !hasOperatorWriteAccess(snapshot.hello?.auth ?? null)) {
      return null;
    }
    return {
      client,
      connectionRevision: gatewayOwner.connectionRevision,
      gatewayUrl: gatewayOwner.connection.gatewayUrl,
      recoveryScope: client.recoveryScope ?? null,
      selfUserId: snapshot.selfUser?.id ?? null,
      selfUserProfileId: snapshot.selfUser?.identity?.id ?? null,
    };
  }

  function sameOnboardingOwner(
    left: OnboardingIdentityOwner | null,
    right: OnboardingIdentityOwner | null,
  ): boolean {
    return (
      left === right ||
      (left !== null &&
        right !== null &&
        left.client === right.client &&
        left.connectionRevision === right.connectionRevision &&
        left.gatewayUrl === right.gatewayUrl &&
        left.recoveryScope === right.recoveryScope &&
        left.selfUserId === right.selfUserId &&
        left.selfUserProfileId === right.selfUserProfileId)
    );
  }

  function isCurrentOnboardingOwner(owner: OnboardingIdentityOwner): boolean {
    const gatewayOwner = context.gateway;
    const snapshot = gatewayOwner.snapshot;
    return (
      !disposed &&
      host.onboarding &&
      onboardingOwner === owner &&
      snapshot.phase === "connected" &&
      snapshot.client === owner.client &&
      gatewayOwner.connectionRevision === owner.connectionRevision &&
      gatewayOwner.connection.gatewayUrl === owner.gatewayUrl &&
      (owner.client.recoveryScope ?? null) === owner.recoveryScope &&
      (snapshot.selfUser?.id ?? null) === owner.selfUserId &&
      (snapshot.selfUser?.identity?.id ?? null) === owner.selfUserProfileId &&
      hasOperatorWriteAccess(snapshot.hello?.auth ?? null)
    );
  }

  function synchronizeOnboardingIdentity(): void {
    observeOnboardingDisplayName();
    const nextOwner = currentOnboardingOwner();
    if (sameOnboardingOwner(onboardingOwner, nextOwner)) {
      if (!nextOwner) {
        setOnboardingNameLoading(false);
      }
      return;
    }
    onboardingOwner = nextOwner;
    onboardingNameRequestEpoch += 1;
    setOnboardingNameProfile(null);
    setOnboardingNameDraft("");
    onboardingLoadPending = false;
    setOnboardingNameLoading(false);
    onboardingSavePending = false;
    setOnboardingNameBusy(false);
    setOnboardingNameError(null);
    if (nextOwner) {
      void loadOnboardingProfile(nextOwner);
    }
  }

  async function loadOnboardingProfile(owner: OnboardingIdentityOwner): Promise<void> {
    if (!isCurrentOnboardingOwner(owner) || onboardingLoadPending) {
      return;
    }
    const requestEpoch = ++onboardingNameRequestEpoch;
    const isCurrent = () =>
      isCurrentOnboardingOwner(owner) && requestEpoch === onboardingNameRequestEpoch;
    onboardingLoadPending = true;
    setOnboardingNameLoading(true);
    setOnboardingNameError(null);
    try {
      const profile = await context.gateway.loadSelfProfile();
      if (!isCurrent()) {
        return;
      }
      setOnboardingNameProfile(profile);
      setOnboardingNameDraft(profile?.displayName ?? "");
    } catch (error) {
      if (isCurrent()) {
        setOnboardingNameError(formatUiError(error, t("custodian.onboardingName.loadFailed")));
      }
    } finally {
      if (isCurrent()) {
        onboardingLoadPending = false;
        setOnboardingNameLoading(false);
      }
    }
  }

  async function saveOnboardingName(): Promise<void> {
    const owner = onboardingOwner;
    const profile = onboardingNameProfile();
    const name = onboardingNameDraft().trim();
    if (!owner || !profile || !name || onboardingSavePending || !isCurrentOnboardingOwner(owner)) {
      return;
    }
    const displayObservationRevisionAtSaveStart = onboardingDisplayObservationRevision;
    const requestEpoch = onboardingNameRequestEpoch;
    const isCurrentRequest = () =>
      isCurrentOnboardingOwner(owner) && onboardingNameRequestEpoch === requestEpoch;
    const isCurrent = () => isCurrentRequest() && onboardingNameProfile() === profile;
    onboardingSavePending = true;
    setOnboardingNameBusy(true);
    setOnboardingNameError(null);
    try {
      const result = await owner.client.request<UsersSetDisplayNameResult>("users.setDisplayName", {
        profileId: profile.id,
        displayName: name,
        onlyIfUnset: true,
      });
      if (!isCurrent()) {
        return;
      }
      const currentSelfUser = context.gateway.snapshot.selfUser;
      const hasNewerDisplayObservation =
        currentSelfUser?.id === profile.id &&
        onboardingDisplayObservationRevision !== displayObservationRevisionAtSaveStart;
      const savedProfile = hasNewerDisplayObservation
        ? { ...result.profile, displayName: currentSelfUser.name ?? null }
        : result.profile;
      setOnboardingNameProfile(savedProfile);
      setOnboardingNameDraft(savedProfile.displayName ?? "");
      if (!hasNewerDisplayObservation) {
        context.gateway.updateSelfUser?.({ name: result.profile.displayName ?? undefined });
      }
    } catch (error) {
      if (isCurrent()) {
        setOnboardingNameError(formatUiError(error, t("custodian.onboardingName.saveFailed")));
      }
    } finally {
      if (isCurrentRequest()) {
        onboardingSavePending = false;
        setOnboardingNameBusy(false);
      }
    }
  }

  function shouldRenderOnboardingNamePrompt(): boolean {
    gateway.read();
    const profile = onboardingNameProfile();
    const error = onboardingNameError();
    const skipped = onboardingNameSkipped();
    const owner = onboardingOwner;
    if (!owner || !isCurrentOnboardingOwner(owner) || skipped) {
      return false;
    }
    return profile ? !profile.displayName?.trim() : error !== null;
  }

  function refreshChannelInventory() {
    const state = channelCapability.state;
    if (
      host.onboarding &&
      !host.store.channelOnboardingNudgeClosed &&
      state.connected &&
      !state.channelsSnapshot &&
      !state.channelsLoading &&
      !state.channelsError
    ) {
      void channelCapability.refresh(false);
    }
  }
  onSettled(() => {
    propertyReceipts.set(host, (key) => {
      presentation.retire();
      if (key === "store") {
        store.replaceSource(host.store);
        void host.store.refreshTranscriptIfIdle();
      }
      refreshChannelInventory();
      synchronizeOnboardingIdentity();
    });
    store.replaceSource(host.store);
    // Setup and channel receipts admit missing onboarding inventory before another refresh.
    const subscriptions = [store, channels].map((source) =>
      source.subscribe(refreshChannelInventory),
    );
    void host.store.refreshTranscriptIfIdle();
    refreshChannelInventory();
    synchronizeOnboardingIdentity();
    return () => {
      disposed = true;
      onboardingNameRequestEpoch += 1;
      onboardingOwner = null;
      propertyReceipts.delete(host);
      subscriptions.forEach((stop) => stop());
    };
  });
  useGatewayPage({
    getGateway: () => context.gateway,
    onSnapshot: ({ initial, becameConnected }) => {
      synchronizeOnboardingIdentity();
      if (
        !initial &&
        becameConnected &&
        props.onboarding &&
        !props.store.channelOnboardingNudgeClosed
      ) {
        void channelCapability.refresh(false);
      }
    },
  });

  function loadHistory(reset: boolean) {
    const owner = historyOwner();
    const client = owner.connection[0];
    const cursor = reset ? undefined : (owner.snapshot.nextCursor ?? undefined);
    if (!client || !owner.connection[1] || owner.busy || (!reset && !cursor)) {
      return;
    }
    owner.busy = true;
    const isCurrent = () =>
      !disposed &&
      historyOwner() === owner &&
      context.gateway.snapshot.phase === "connected" &&
      context.gateway.snapshot.client === client &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.changes.list") === true;
    const completion = client
      .request<SystemChangesListResult>("openclaw.changes.list", {
        limit: 50,
        ...(cursor ? { beforeCursor: cursor } : {}),
      })
      .catch(() => null)
      .then((result) => {
        if (!isCurrent()) {
          return owner.snapshot;
        }
        owner.busy = false;
        owner.snapshot = {
          ...owner.snapshot,
          loaded: true,
          error: result ? null : t("custodian.history.requestFailed"),
          ...(result
            ? {
                entries: reset ? result.entries : [...owner.snapshot.entries, ...result.entries],
                nextCursor: result.nextCursor ?? null,
              }
            : {}),
        };
        return owner.snapshot;
      });
    setHistoryReceipt({ owner, reset, result: completion });
  }
  const channelResult = createMemo(() => {
    const state = channels.read();
    const receipt = state.channelsRead;
    const snapshot = state.channelsSnapshot;
    const completion = receipt?.completion ?? Promise.resolve(state.channelsError);
    return completion.then((error) => ({
      error,
      snapshot: receipt ? state.channelsSnapshot : snapshot,
    }));
  });
  const channelSnapshot = createMemo(() => {
    const result = latest(channelResult);
    if (result.error) {
      throw new Error(result.error);
    }
    return result.snapshot;
  });
  const channelError = (retrying: boolean, retry: () => void) => (
    <CustodianChannelOnboardingNudge
      error
      retrying={retrying}
      onAction={retry}
      onDismiss={() => props.store.dismissChannelOnboardingNudge()}
    />
  );
  const PendingChannelInventory = () => (
    <Show when={channels.read().channelsError}>{channelError(true, () => {})}</Show>
  );
  const ChannelOnboarding = () => (
    <Show
      when={
        props.onboarding && !store.read().channelOnboardingNudgeClosed && channels.read().connected
      }
    >
      <Loading fallback={<PendingChannelInventory />}>
        {/* Retained errors must not hide the pending reconnect or retry state. */}
        <Show when={!isPending(channelResult)} fallback={<PendingChannelInventory />}>
          <Errored
            fallback={(_error, reset) =>
              channelError(false, () => {
                void channelCapability.refresh(false);
                reset();
              })
            }
          >
            <Show
              when={
                channelSnapshot() !== null &&
                channelSnapshot()?.partial !== true &&
                !channelSnapshotHasActiveChannel(channelSnapshot())
              }
            >
              <CustodianChannelOnboardingNudge
                error={false}
                retrying={false}
                onAction={() => props.store.openChannelsFromOnboarding()}
                onDismiss={() => props.store.dismissChannelOnboardingNudge()}
              />
            </Show>
          </Errored>
        </Show>
      </Loading>
    </Show>
  );
  return (
    <section
      aria-busy={props.onboarding ? (onboardingNameLoading() ? "true" : "false") : undefined}
      class={[
        "custodian custodian--page",
        {
          "custodian--setup-required": store.read().setupRequired,
          "custodian--onboarding": shouldRenderOnboardingNamePrompt(),
        },
      ]}
    >
      <div class="custodian__column">
        <header
          class={[
            "custodian__header custodian__column",
            { "custodian__header--minimal": props.onboarding },
          ]}
        >
          <Show when={!props.onboarding}>
            <div class="custodian__identity">
              <div class="custodian__mark" aria-hidden="true">
                <openclaw-mascot mood={store.read().sending ? "thinking" : "idle"} prop:size={38} />
              </div>
              <div>
                <h1>{t("custodian.title")}</h1>
                <p>{t("custodian.subtitleCaretaker")}</p>
              </div>
            </div>
          </Show>
          <div class="custodian__header-actions">
            <Show when={props.onboarding}>
              <Errored
                fallback={(error, reset) => (
                  <LazyViewError error={error()} onRetry={reset} inline />
                )}
              >
                <Loading>
                  <SidebarAttention />
                </Loading>
              </Errored>
            </Show>
            <Show when={historyAvailable()}>
              <button
                class="btn btn--ghost custodian__history-toggle"
                type="button"
                aria-expanded={historyOpen() ? "true" : "false"}
                onClick={() => {
                  const open = !historyOpen();
                  setHistoryOpen(open);
                  if (open && !historyOwner().busy) {
                    loadHistory(true);
                  }
                }}
              >
                {t("custodian.history.button")}
              </button>
            </Show>
            <Show when={props.onboarding}>
              <button class="btn btn--ghost" type="button" onClick={() => props.store.exitSetup()}>
                {t("custodian.exitSetup")}
              </button>
            </Show>
          </div>
        </header>
        <Show when={shouldRenderOnboardingNamePrompt()}>
          <section
            class="custodian__name-prompt custodian-setup"
            aria-labelledby={onboardingNameProfile() ? "custodian-name-title" : undefined}
          >
            <Show
              when={onboardingNameProfile()}
              fallback={
                <p class="custodian__error" role="alert">
                  <span>{onboardingNameError()}</span>
                  <button
                    class="btn btn--sm"
                    type="button"
                    disabled={onboardingNameLoading()}
                    onClick={() => {
                      if (onboardingOwner) {
                        void loadOnboardingProfile(onboardingOwner);
                      }
                    }}
                  >
                    {onboardingNameLoading() ? t("common.loading") : t("common.retry")}
                  </button>
                </p>
              }
            >
              <div>
                <h2 id="custodian-name-title">{t("custodian.onboardingName.title")}</h2>
                <p id="custodian-name-description" class="muted">
                  {t("custodian.onboardingName.description")}
                </p>
              </div>
              <form
                class="custodian__name-form wizard-step__options"
                aria-busy={onboardingNameBusy() ? "true" : "false"}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveOnboardingName();
                }}
              >
                <label for="custodian-onboarding-display-name">
                  {t("custodian.onboardingName.label")}
                </label>
                <input
                  id="custodian-onboarding-display-name"
                  class="settings-input"
                  type="text"
                  maxlength={256}
                  autocomplete="nickname"
                  aria-describedby={
                    onboardingNameError()
                      ? "custodian-name-description custodian-name-error"
                      : "custodian-name-description"
                  }
                  value={onboardingNameDraft()}
                  disabled={onboardingNameBusy()}
                  onInput={(event) => {
                    setOnboardingNameDraft(event.currentTarget.value);
                    setOnboardingNameError(null);
                  }}
                />
                <Show when={onboardingNameError()}>
                  <p id="custodian-name-error" class="custodian-setup__error" role="alert">
                    {onboardingNameError()}
                  </p>
                </Show>
                <div class="custodian__name-actions wizard-step__actions wizard-step__actions--split">
                  <button
                    class="btn btn--ghost"
                    type="button"
                    disabled={onboardingNameBusy()}
                    onClick={() => setOnboardingNameSkipped(true)}
                  >
                    {t("custodian.onboardingName.skip")}
                  </button>
                  <button
                    class="btn"
                    type="submit"
                    disabled={onboardingNameBusy() || !onboardingNameDraft().trim()}
                  >
                    {onboardingNameBusy() ? t("common.saving") : t("custodian.onboardingName.save")}
                  </button>
                </div>
              </form>
            </Show>
          </section>
        </Show>
      </div>
      <CustodianSurface
        class="custodian__column"
        store={props.store}
        actions={presentation.actions}
        onboarding={props.onboarding}
        newAgentIntent={props.newAgentIntent}
        channelOnboardingContent={<ChannelOnboarding />}
        historyContent={
          <Show when={historyOpen() && historyAvailable()}>
            <CustodianChangeHistory
              request={historyReceipt()}
              previous={historyOwner().snapshot}
              onLoad={loadHistory}
            />
          </Show>
        }
      />
    </section>
  );
}

export const CustodianPage = defineSolidBridge<Props>(
  "openclaw-custodian-page",
  CustodianPageContent,
  {
    properties: {
      onboarding: { default: false, attribute: false },
      newAgentIntent: { default: false, attribute: false },
      store: { default: custodianSessionStore, attribute: false },
    },
    propertyChanged: (host, key) => {
      propertyReceipts.get(host)?.(key);
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-page": SolidBridgeElement<Props>;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sidebar-attention": SidebarAttentionElementAttributes;
    }
  }
}

export function CustodianRoute(props: { data?: CustodianRouteData }) {
  return (
    <Show when={props.data}>
      {(data) => (
        <CustodianPage
          onboarding={data().onboarding}
          newAgentIntent={data().intent === "new-agent"}
        />
      )}
    </Show>
  );
}
