import type { BoardGetParams, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { SessionProgressCardController } from "../../../components/session-progress-card-controller.ts";
import { SessionProgressCard } from "../../../components/session-progress-card-solid.tsx";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { useSolidControllerHost } from "../../../lit/solid-controller-host.ts";
import { useOptionalApplication } from "../../reactive/context.ts";
import { t } from "../../reactive/i18n.ts";
import { projectSource } from "../../reactive/projection.ts";
import { resolveSessionProgressCardTarget } from "../../session-progress-cards.ts";
import { isSessionRunActive } from "../../session-run-state.ts";
import { parseAgentSessionKey } from "../../sessions/session-key.ts";
import { sessionProgressTargetQuery } from "../../sessions/session-requests.ts";
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
  const lifecycle = useSolidControllerHost(() => [target(), props.active, gateway.read()]);
  const progress = new SessionProgressCardController(lifecycle.host, {
    gateway: () =>
      host.isConnected && props.active && target().sessionKey ? context?.gateway : undefined,
    target,
  });
  const [sessionRevision, setSessionRevision] = createSignal(0, { ownedWrite: true });
  const rosterScope = createMemo(
    () => {
      lifecycle.revision();
      return [
        identity().agentId,
        props.active && Boolean(target().sessionKey),
        host.isConnected,
      ] as const;
    },
    {
      equals: (previous, next) =>
        previous[0] === next[0] && previous[1] === next[1] && previous[2] === next[2],
    },
  );
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
  const state = createMemo(() => {
    lifecycle.revision();
    return { card: progress.card, error: progress.error, loading: progress.loading };
  });
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
            <button class="btn btn--sm" type="button" onClick={progress.retry}>
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
                hasActiveRun={isSessionRunActive(row() ?? {})}
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
