import type { SystemChangesListResult } from "@openclaw/gateway-protocol";
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
import "../../components/openclaw-mascot.tsx";
import type { SidebarAttentionElementAttributes } from "../../components/sidebar-attention-element.ts";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { channelSnapshotHasActiveChannel } from "../../lib/channels/index.ts";
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

type Props = { onboarding: boolean; newAgentIntent: boolean; store: CustodianSessionStore };
const SidebarAttention = lazy(() => import("../../components/sidebar-attention.tsx"), {
  export: "SidebarAttention",
});
const propertyReceipts = new WeakMap<HTMLElement, (key: keyof Props) => void>();
function CustodianPageContent(props: Props, host: SolidBridgeElement<Props>) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const channels = projectChannels(context.channels);
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
  function refreshChannelInventory() {
    const state = context.channels.state;
    if (
      host.onboarding &&
      !host.store.channelOnboardingNudgeClosed &&
      state.connected &&
      !state.channelsSnapshot &&
      !state.channelsLoading &&
      !state.channelsError
    ) {
      void context.channels.refresh(false);
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
    });
    store.replaceSource(host.store);
    // Setup and channel receipts admit missing onboarding inventory before another refresh.
    const subscriptions = [store, channels].map((source) =>
      source.subscribe(refreshChannelInventory),
    );
    void host.store.refreshTranscriptIfIdle();
    refreshChannelInventory();
    return () => {
      disposed = true;
      propertyReceipts.delete(host);
      subscriptions.forEach((stop) => stop());
    };
  });
  useGatewayPage({
    getGateway: () => context.gateway,
    onSnapshot: ({ initial, becameConnected }) => {
      if (
        !initial &&
        becameConnected &&
        props.onboarding &&
        !props.store.channelOnboardingNudgeClosed
      ) {
        void context.channels.refresh(false);
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
                void context.channels.refresh(false);
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
      class={[
        "custodian custodian--page",
        { "custodian--setup-required": store.read().setupRequired },
      ]}
    >
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
              fallback={(error, reset) => <LazyViewError error={error()} onRetry={reset} inline />}
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
