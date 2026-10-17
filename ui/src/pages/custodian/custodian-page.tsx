import type { SystemChangeEntry, SystemChangesListResult } from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import "../../components/openclaw-mascot.ts";
import type { SidebarAttentionElementAttributes } from "../../components/sidebar-attention-element.ts";
import { channelSnapshotHasActiveChannel } from "../../lib/channels/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectChannels } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import "../../styles/custodian.css";
import { CustodianChangeHistory } from "./custodian-history.tsx";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import { CustodianSurface } from "./custodian-surface.tsx";
import type { CustodianRouteData } from "./route.ts";

type Props = { onboarding: boolean; newAgentIntent: boolean; store: CustodianSessionStore };
type History = {
  open: boolean;
  entries: SystemChangeEntry[];
  nextCursor: string | null;
  load: "idle" | "initial" | "more";
  error: string | null;
  loaded: boolean;
};
function CustodianPageContent(props: Props) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const channels = projectChannels(context.channels);
  const store = createMemo(() => projectOwner(props.store, (source) => source));
  // The provided session owner decides when its Gateway transcript needs refreshing.
  createEffect(
    () => props.store,
    (source) => void source.refreshTranscriptIfIdle(),
  );
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
  const historyOwner = createMemo(() => ({ connection: historyConnection(), busy: false }));
  // History drafts reset with the connection; local requests share its synchronous admission state.
  const [history, setHistory] = createSignal<History>((): History => {
    historyConnection();
    return { open: false, entries: [], nextCursor: null, load: "idle", error: null, loaded: false };
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  // Refresh the Gateway channel inventory while onboarding needs its initial snapshot.
  createEffect(
    () => [props.onboarding, store().read().channelOnboardingNudgeClosed, channels.read()] as const,
    ([onboarding, closed, state]) => {
      if (
        onboarding &&
        !closed &&
        state.connected &&
        !state.channelsSnapshot &&
        !state.channelsLoading &&
        !state.channelsError
      ) {
        void context.channels.refresh(false);
      }
    },
  );

  async function loadHistory(reset: boolean) {
    const owner = historyOwner();
    const client = owner.connection[0];
    const cursor = reset ? undefined : (history().nextCursor ?? undefined);
    if (!client || !owner.connection[1] || owner.busy || (!reset && !cursor)) {
      return;
    }
    owner.busy = true;
    setHistory((previous) => ({ ...previous, load: reset ? "initial" : "more", error: null }));
    const isCurrent = () =>
      !disposed &&
      historyOwner() === owner &&
      context.gateway.snapshot.phase === "connected" &&
      context.gateway.snapshot.client === client &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.changes.list") === true;
    const result = await client
      .request<SystemChangesListResult>("openclaw.changes.list", {
        limit: 50,
        ...(cursor ? { beforeCursor: cursor } : {}),
      })
      .catch(() => null);
    if (!isCurrent()) {
      return;
    }
    owner.busy = false;
    setHistory((previous) => ({
      ...previous,
      load: "idle",
      loaded: true,
      ...(result
        ? {
            entries: reset ? result.entries : [...previous.entries, ...result.entries],
            nextCursor: result.nextCursor ?? null,
          }
        : { error: t("custodian.history.requestFailed") }),
    }));
  }
  const channelStatusError = () =>
    props.onboarding && !store().read().channelOnboardingNudgeClosed && channels.read().connected
      ? channels.read().channelsError
      : null;
  const showChannelOnboardingNudge = () => {
    const state = channels.read();
    const snapshot = state.channelsSnapshot;
    return (
      props.onboarding &&
      !store().read().channelOnboardingNudgeClosed &&
      state.connected &&
      !state.channelsLoading &&
      channelStatusError() === null &&
      snapshot !== null &&
      snapshot.partial !== true &&
      !channelSnapshotHasActiveChannel(snapshot)
    );
  };
  return (
    <section
      class={[
        "custodian custodian--page",
        { "custodian--setup-required": store().read().setupRequired },
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
              <openclaw-mascot mood={store().read().sending ? "thinking" : "idle"} prop:size={38} />
            </div>
            <div>
              <h1>{t("custodian.title")}</h1>
              <p>{t("custodian.subtitleCaretaker")}</p>
            </div>
          </div>
        </Show>
        <div class="custodian__header-actions">
          <Show when={props.onboarding}>
            <openclaw-sidebar-attention />
          </Show>
          <Show when={historyAvailable()}>
            <button
              class="btn btn--ghost custodian__history-toggle"
              type="button"
              aria-expanded={history().open ? "true" : "false"}
              onClick={() => {
                const open = !history().open;
                setHistory((previous) => ({ ...previous, open }));
                if (open && !historyOwner().busy) {
                  void loadHistory(true);
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
        onboarding={props.onboarding}
        newAgentIntent={props.newAgentIntent}
        showChannelOnboardingNudge={showChannelOnboardingNudge()}
        channelOnboardingError={channelStatusError()}
        channelOnboardingRetrying={channels.read().channelsLoading}
        onRetryChannelOnboarding={() => void context.channels.refresh(false)}
        historyContent={
          <Show when={history().open && historyAvailable()}>
            <CustodianChangeHistory
              entries={history().entries}
              error={history().error}
              loaded={history().loaded}
              loading={history().load === "initial"}
              loadingMore={history().load === "more"}
              nextCursor={history().nextCursor}
              onLoad={(reset) => void loadHistory(reset)}
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
