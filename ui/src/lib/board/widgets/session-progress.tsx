import type { BoardGetParams, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from "solid-js";
import { SessionProgressCard } from "../../../components/session-progress-card-solid.tsx";
import { useOptionalApplication } from "../../reactive/context.ts";
import { projectProgressCard } from "../../reactive/domain-keyed.ts";
import { t } from "../../reactive/i18n.ts";
import { projectSource } from "../../reactive/projection.ts";
import {
  resolveSessionProgressCardTarget,
  sessionProgressCardsForGateway,
} from "../../session-progress-cards.ts";
import { isSessionRunStateActive } from "../../session-run-state.ts";
import { parseAgentSessionKey } from "../../sessions/session-key.ts";
import { sessionProgressTargetQuery } from "../../sessions/session-requests.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../solid-bridge.ts";
import type { BoardWidget } from "../types.ts";

type SessionProgressWidgetProps = {
  widget?: BoardWidget;
  session: BoardGetParams;
  active: boolean;
};
function resolveSessionTarget(
  widget: BoardWidget | undefined,
  boardSession: BoardGetParams,
): ProgressCardGetParams {
  const value = widget?.props?.sessionKey;
  const key = typeof value === "string" ? value.trim() : "";
  // Unqualified overrides retain the board's captured owner; qualified links name their own.
  return key
    ? { sessionKey: key, agentId: parseAgentSessionKey(key)?.agentId ?? boardSession.agentId }
    : boardSession;
}

function SessionProgressWidgetContent(
  props: SessionProgressWidgetProps,
  host: SolidBridgeElement<SessionProgressWidgetProps>,
) {
  const context = useOptionalApplication();
  const gateway = projectSource(context?.gateway, {
    read: (owner) => owner?.snapshot,
    subscribe: (owner, notify) => owner?.subscribe(notify) ?? (() => {}),
    equality: "revision",
  });
  const target = createMemo(() => resolveSessionTarget(props.widget, props.session));
  const identity = createMemo(() =>
    resolveSessionProgressCardTarget(gateway.read() ?? {}, target()),
  );
  const [mounted, setMounted] = createSignal(false);
  onSettled(() => {
    setMounted(true);
  });
  const progressScope = createMemo(
    () => {
      const snapshot = gateway.read();
      const staticTarget = target();
      return {
        store:
          mounted() && props.active && staticTarget.sessionKey && context
            ? sessionProgressCardsForGateway(context.gateway)
            : undefined,
        target: staticTarget,
        client: snapshot?.client,
        hello: snapshot?.hello,
        options: {
          // Read live admission facts even before the scope effect catches up.
          admitAutomaticRead: () =>
            untrack(
              () =>
                host.isConnected &&
                props.active &&
                target().sessionKey === staticTarget.sessionKey &&
                target().agentId === staticTarget.agentId &&
                context?.gateway.snapshot.client === snapshot?.client &&
                context?.gateway.snapshot.hello === snapshot?.hello,
            ),
        },
      };
    },
    {
      equals: (a, b) =>
        a.store === b.store &&
        a.client === b.client &&
        a.hello === b.hello &&
        a.target.sessionKey === b.target.sessionKey &&
        a.target.agentId === b.target.agentId,
    },
  );
  // Initial source identity is a one-time snapshot; the effect owns replacements.
  const progress = projectProgressCard(untrack(progressScope));
  // Bind the imperative store watch only while the widget is active.
  createEffect(progressScope, (next) => progress.replaceSource(next));
  const [sessionRevision, setSessionRevision] = createSignal(0, { ownedWrite: true });
  const rosterScope = createMemo(
    () => {
      return [
        identity().agentId,
        mounted() && props.active && Boolean(target().sessionKey),
        host.isConnected,
      ] as const;
    },
    {
      equals: (previous, next) =>
        previous[0] === next[0] && previous[1] === next[1] && previous[2] === next[2],
    },
  );
  // The session roster's imperative subscription and reads follow the visible widget scope.
  createEffect(rosterScope, ([agentId, active, connected]) => {
    if (!connected || !context || !active) {
      return undefined;
    }
    const query = sessionProgressTargetQuery(agentId);
    const release = context.sessions.subscribeList(query, () =>
      setSessionRevision((value) => value + 1),
    );
    const snapshot = context.sessions.listSnapshot(query);
    if (
      !snapshot.result &&
      !snapshot.loading &&
      !snapshot.error &&
      context.gateway.snapshot.phase === "connected"
    ) {
      void context.sessions.refreshList(query);
    }
    return release;
  });
  const row = createMemo(() => {
    sessionRevision();
    const current = identity();
    return context?.sessions
      .listSnapshot(sessionProgressTargetQuery(current.agentId))
      .result?.sessions.find(
        (entry) =>
          entry.key === current.sessionKey &&
          (entry.agentId ?? parseAgentSessionKey(entry.key)?.agentId) === current.agentId,
      );
  });
  const state = createMemo(progress.read);
  const ErrorNotice = () => (
    <Show when={state().error}>
      {(error) => (
        <div
          class={state().card ? "callout info" : "board-widget__plugin-loading"}
          data-test-id="session-progress-error"
          role="alert"
        >
          <span>
            {t(
              error() === "access-denied"
                ? "sessionProgressCard.widgetAccessDenied"
                : "sessionProgressCard.widgetUnavailable",
            )}
          </span>
          <Show when={error() === "unavailable"}>
            <button
              class="btn btn--sm"
              type="button"
              onClick={() => {
                void progressScope()
                  .store?.load(target())
                  .catch(() => undefined);
              }}
            >
              {t("common.retry")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
  return (
    <>
      <ErrorNotice />
      <Show when={!state().error || state().card}>
        <Show
          when={!state().loading}
          fallback={
            <p class="board-widget__plugin-loading">{t("sessionProgressCard.widgetLoading")}</p>
          }
        >
          <Show
            when={state().card}
            fallback={
              <p class="board-widget__plugin-loading">{t("sessionProgressCard.widgetEmpty")}</p>
            }
          >
            {(card) => (
              <SessionProgressCard
                card={card()}
                placement="board"
                sessionStatus={row()?.status}
                startedAt={row()?.startedAt}
                endedAt={row()?.endedAt}
                hasActiveRun={isSessionRunStateActive(row() ?? {})}
              />
            )}
          </Show>
        </Show>
      </Show>
    </>
  );
}
export const SessionProgressWidget = defineSolidBridge<SessionProgressWidgetProps>(
  "openclaw-session-progress-widget",
  SessionProgressWidgetContent,
  {
    properties: {
      widget: { default: undefined, attribute: false },
      session: { default: { sessionKey: "" }, attribute: false },
      active: { default: true, attribute: false },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-progress-widget": SolidBridgeElement<SessionProgressWidgetProps>;
  }
}
