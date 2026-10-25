import type { BoardGetParams, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { createMemo, createSignal, Errored, latest, Loading, onSettled, Show } from "solid-js";
import { SessionProgressCard } from "../../../components/session-progress-card-solid.tsx";
import { projectGateway } from "../../reactive/application.ts";
import { useOptionalApplication } from "../../reactive/context.ts";
import { projectProgressCard } from "../../reactive/domain-keyed.ts";
import { t } from "../../reactive/i18n.ts";
import { projectSource } from "../../reactive/projection.ts";
import { projectSessionProgressRoster } from "../../reactive/session-progress-roster.ts";
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
  const gateway = context ? projectGateway(context.gateway) : undefined;
  const target = createMemo(() => resolveSessionTarget(props.widget, props.session));
  const identity = createMemo(() =>
    resolveSessionProgressCardTarget(gateway?.read().snapshot ?? {}, target()),
  );
  const [mounted, setMounted] = createSignal(false);
  onSettled(() => {
    setMounted(true);
  });
  const progressScope = createMemo(
    () => {
      const snapshot = gateway?.read().snapshot;
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
          admitAutomaticRead: () => {
            const currentTarget = resolveSessionTarget(host.widget, host.session);
            return (
              host.isConnected &&
              host.active &&
              currentTarget.sessionKey === staticTarget.sessionKey &&
              currentTarget.agentId === staticTarget.agentId &&
              context?.gateway.snapshot.client === snapshot?.client &&
              context?.gateway.snapshot.hello === snapshot?.hello
            );
          },
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
  const progress = projectProgressCard(progressScope);
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
  const roster = createMemo(() =>
    projectSource(rosterScope(), {
      read: ([agentId]) => context?.sessions.listSnapshot(sessionProgressTargetQuery(agentId)),
      subscribe: ([agentId, active, connected], notify) => {
        if (!context || !active || !connected) {
          return () => {};
        }
        // A scoped child releases on invalidation even when an empty card never rereads it.
        return projectSessionProgressRoster(context.sessions, agentId).subscribe(notify);
      },
      equality: "revision",
    }),
  );
  const row = createMemo(() => {
    const current = identity();
    return roster()
      .read()
      ?.result?.sessions.find(
        (entry) =>
          entry.key === current.sessionKey &&
          (entry.agentId ?? parseAgentSessionKey(entry.key)?.agentId) === current.agentId,
      );
  });
  const card = createMemo(() => progress.read().card);
  const error = createMemo(() => progress.read().error);
  const receipt = createMemo(() => ({ completion: progress.read().completion }), {
    equals: (previous, next) => previous.completion === next.completion,
  });
  // Readiness observes the owner's admitted work; accepted cards stay independently live.
  const ready = createMemo(() => receipt().completion?.then(() => null) ?? null);
  const LoadingNotice = () => (
    <Show when={card() === undefined}>
      <p class="board-widget__plugin-loading">{t("sessionProgressCard.widgetLoading")}</p>
    </Show>
  );
  const ErrorNotice = () => (
    <Show when={error()}>
      {(failure) => (
        <div
          class={card() ? "callout info" : "board-widget__plugin-loading"}
          data-test-id="session-progress-error"
          role="alert"
        >
          <span>
            {t(
              failure() === "access-denied"
                ? "sessionProgressCard.widgetAccessDenied"
                : "sessionProgressCard.widgetUnavailable",
            )}
          </span>
          <Show when={failure() === "unavailable"}>
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
      <Show when={!error() || card()}>
        <Loading on={receipt()} fallback={<LoadingNotice />}>
          <Errored fallback={null}>{card() === undefined ? ready() : latest(ready)}</Errored>
          <Show when={!receipt().completion}>
            <LoadingNotice />
          </Show>
        </Loading>
        <Show when={card() !== undefined}>
          <Show
            when={card()}
            fallback={
              <p class="board-widget__plugin-loading">{t("sessionProgressCard.widgetEmpty")}</p>
            }
          >
            {(acceptedCard) => (
              <SessionProgressCard
                card={acceptedCard()}
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
