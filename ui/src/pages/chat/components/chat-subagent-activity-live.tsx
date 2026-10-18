import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createSignal, onSettled } from "solid-js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayEventFrame } from "../../../api/gateway.ts";
import { createSidebarNarration } from "../../../components/app-sidebar-session-narration.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { pickFreshestObserverDigest } from "../../../lib/observer-digest.ts";
import { isSessionObserverDigest } from "../../../lib/protocol-validators.generated/activity.js";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  resolveUiSessionRowAgentId,
} from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { ChatSubagentActivity as ChatSubagentActivityRow } from "../chat-subagent-wait.ts";
import { SubagentActivity, type SubagentActivityProps } from "./chat-subagent-activity.ts";

function matchesRun(
  row: ChatSubagentActivityRow,
  digest: {
    sessionKey?: unknown;
    runId?: unknown;
    agentId?: unknown;
    sessionId?: unknown;
    lifecycleRevision?: unknown;
  },
): boolean {
  const session = row.session;
  return (
    row.status === "running" &&
    typeof digest.sessionKey === "string" &&
    areUiSessionKeysEquivalent(row.key, digest.sessionKey) &&
    typeof digest.runId === "string" &&
    session.activeRunIds?.includes(digest.runId) === true &&
    (typeof digest.agentId !== "string" ||
      normalizeAgentId(digest.agentId) === resolveUiSessionRowAgentId(session, "")) &&
    (!digest.sessionId || digest.sessionId === session.sessionId) &&
    (!digest.lifecycleRevision || digest.lifecycleRevision === session.lifecycleRevision)
  );
}

/** Reuse bounded narration subscriptions; inline progress never reads child history. */
function SubagentActivityLive(props: SubagentActivityProps) {
  const context = useOptionalApplication();
  // The cache retains only digests belonging to the currently displayed runs.
  const [digests, setDigests] = createSignal<Map<string, SessionObserverDigest>>(
    (previous = new Map()) => {
      const rows = props.rows;
      return new Map(
        [...previous].filter(([key, digest]) =>
          rows.some((row) => row.key === key && matchesRun(row, digest)),
        ),
      );
    },
  );
  const narration = createSidebarNarration();
  const narrationView = projectOwner(narration, (owner) => owner.read());
  const syncNarration = (rows: readonly ChatSubagentActivityRow[], enabled: boolean) => {
    if (!context) {
      return;
    }
    narration.sync({
      enabled,
      connected: Boolean(context.gateway.snapshot.hello),
      connectionIdentity: context.gateway.snapshot.hello,
      source: context.sessions,
      rows: rows
        .filter((row) => row.status === "running")
        .map((row) => ({
          key: row.key,
          hasActiveRun: true,
          startedAt: row.session.startedAt,
          updatedAt: row.session.updatedAt,
        })),
      openSessionKey: "",
      agentId: context.gateway.snapshot.assistantAgentId ?? "main",
    });
  };
  createEffect(
    () => ({
      rows: props.limit === undefined ? props.rows : props.rows.slice(0, props.limit),
      enabled: !props.compact && props.presented !== false,
    }),
    ({ rows, enabled }) => syncNarration(rows, enabled),
  );
  onSettled(() => {
    if (!context) {
      return undefined;
    }
    const gateway = context.gateway;
    let connection = gateway.snapshot.hello;
    // Clear prior-connection digests before the next observer frame can be accepted.
    const unsubscribe = gateway.subscribe(() => {
      syncNarration(
        props.limit === undefined ? props.rows : props.rows.slice(0, props.limit),
        !props.compact && props.presented !== false,
      );
      if (connection !== gateway.snapshot.hello) {
        connection = gateway.snapshot.hello;
        setDigests(new Map());
      }
    });
    function onSessionObserver(event: GatewayEventFrame) {
      if (event.event !== "session.observer") {
        const payload = asOptionalRecord(event.payload);
        if (payload && props.rows.some((row) => matchesRun(row, payload))) {
          narration.handleEvent(event);
        }
        return;
      }
      if (
        !connection ||
        connection !== gateway.snapshot.hello ||
        !isSessionObserverDigest(event.payload)
      ) {
        return;
      }
      const digest = event.payload;
      const row = props.rows.find((candidate) => matchesRun(candidate, digest));
      if (!row) {
        return;
      }
      setDigests((previous) =>
        pickFreshestObserverDigest(previous.get(row.key), digest) === digest
          ? new Map(previous).set(row.key, digest)
          : previous,
      );
    }
    const unsubscribeEvents = gateway.subscribeEvents(onSessionObserver);
    return () => {
      unsubscribe();
      unsubscribeEvents();
      narration.disconnect();
    };
  });
  const rows = () => {
    const liveDigests = digests();
    const liveNarration = narrationView.read();
    return props.rows.map((row) => {
      const live = liveDigests.get(row.key);
      const stored = row.session.observerDigest;
      const digest = pickFreshestObserverDigest(
        live && matchesRun(row, live) ? live : undefined,
        stored?.runId && row.session.activeRunIds?.includes(stored.runId) ? stored : undefined,
      );
      const narrationRun = liveNarration.runIds.get(row.key);
      const currentNarration =
        row.status === "running" &&
        narrationRun &&
        row.session.activeRunIds?.includes(narrationRun);
      const tool = currentNarration ? liveNarration.tools.get(row.key) : undefined;
      return {
        ...row,
        activity:
          (currentNarration ? liveNarration.lines.get(row.key) : undefined) ||
          tool?.text ||
          (tool ? resolveToolDisplay({ name: tool.name }).label : undefined) ||
          digest?.headline.trim() ||
          row.activity,
        // Session rows omit plan steps, so only a winning live digest carries them.
        progress:
          live && digest === live && live.planProgress?.total ? live.planProgress : undefined,
      };
    });
  };
  return <SubagentActivity {...props} rows={rows()} />;
}

export const ChatSubagentActivity = defineSolidBridge<SubagentActivityProps>(
  "openclaw-chat-subagent-activity",
  (props) => <SubagentActivityLive {...props} />,
  {
    properties: {
      rows: { default: [], attribute: false },
      compact: { default: false },
      presented: { default: true },
      limit: { default: undefined, attribute: false },
      turnStartedAt: { default: undefined, attribute: false },
      onOpenSubagent: { default: undefined, attribute: false },
      onOpenSession: { default: undefined, attribute: false },
    },
    connected: (host) => {
      host.style.display = "contents";
    },
  },
);
type ChatSubagentActivityElement = SolidBridgeElement<SubagentActivityProps>;

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-subagent-activity": HTMLAttributes<ChatSubagentActivityElement> &
        Properties<ChatSubagentActivityElement> & {
          "prop:rows"?: SubagentActivityProps["rows"];
          "prop:compact"?: SubagentActivityProps["compact"];
          "prop:presented"?: SubagentActivityProps["presented"];
          "prop:limit"?: SubagentActivityProps["limit"];
          "prop:turnStartedAt"?: SubagentActivityProps["turnStartedAt"];
          "prop:onOpenSubagent"?: SubagentActivityProps["onOpenSubagent"];
          "prop:onOpenSession"?: SubagentActivityProps["onOpenSession"];
        };
    }
  }
}
