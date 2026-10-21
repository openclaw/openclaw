import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createStore, onSettled } from "solid-js";
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

const inputHandlers = new WeakMap<HTMLElement, () => void>();

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
function SubagentActivityLive(
  props: SubagentActivityProps,
  host: SolidBridgeElement<SubagentActivityProps>,
) {
  const context = useOptionalApplication();
  // The cache retains only digests belonging to the currently displayed runs.
  const [digests, setDigests] = createStore<Record<string, SessionObserverDigest>>(
    (draft: Record<string, SessionObserverDigest>) => {
      const rows = props.rows;
      for (const [key, digest] of Object.entries(draft)) {
        if (!rows.some((row) => row.key === key && matchesRun(row, digest))) {
          delete draft[key];
        }
      }
    },
    Object.create(null),
    // Digests arrive as complete immutable records; retain their raw identity.
    { shallow: true },
  );
  const narration = createSidebarNarration();
  const narrationView = projectOwner(narration, (owner) => owner.read());
  let active = false;
  let queued = false;
  const syncNarration = () => {
    if (!active || !context) {
      return;
    }
    const rows = host.limit === undefined ? host.rows : host.rows.slice(0, host.limit);
    narration.sync({
      enabled: !host.compact && host.presented !== false,
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
  onSettled(() => {
    if (!context) {
      return undefined;
    }
    active = true;
    inputHandlers.set(host, () => {
      if (host.compact || host.presented === false) {
        syncNarration();
      } else if (!queued) {
        queued = true;
        queueMicrotask(() => {
          queued = false;
          syncNarration();
        });
      }
    });
    syncNarration();
    const gateway = context.gateway;
    let connection = gateway.snapshot.hello;
    // Clear prior-connection digests before the next observer frame can be accepted.
    const unsubscribe = gateway.subscribe(() => {
      syncNarration();
      if (connection !== gateway.snapshot.hello) {
        connection = gateway.snapshot.hello;
        setDigests((draft) => {
          for (const key of Object.keys(draft)) {
            delete draft[key];
          }
        });
      }
    });
    function onSessionObserver(event: GatewayEventFrame) {
      if (event.event !== "session.observer") {
        const payload = asOptionalRecord(event.payload);
        if (payload && host.rows.some((row) => matchesRun(row, payload))) {
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
      const row = host.rows.find((candidate) => matchesRun(candidate, digest));
      if (!row) {
        return;
      }
      setDigests((draft) => {
        if (pickFreshestObserverDigest(draft[row.key], digest) === digest) {
          draft[row.key] = digest;
        }
      });
    }
    const unsubscribeEvents = gateway.subscribeEvents(onSessionObserver);
    return () => {
      active = false;
      inputHandlers.delete(host);
      unsubscribe();
      unsubscribeEvents();
      narration.disconnect();
    };
  });
  const rows = () => {
    const liveNarration = narrationView.read();
    return props.rows.map((row) => {
      const live = digests[row.key];
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
  SubagentActivityLive,
  {
    propertyChanged: (host, key) => {
      if (key === "rows" || key === "compact" || key === "presented" || key === "limit") {
        inputHandlers.get(host)?.();
      }
    },
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
