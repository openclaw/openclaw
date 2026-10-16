import { createEffect, createSignal, onSettled, untrack } from "solid-js";
import { Value } from "typebox/value";
import {
  SessionObserverDigestSchema,
  type SessionObserverDigest,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayEventFrame } from "../../../api/gateway.ts";
import { pickFreshestObserverDigest } from "../../../lib/observer-digest.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  resolveUiSessionRowAgentId,
} from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import type { ChatSubagentActivity as ChatSubagentActivityRow } from "../chat-subagent-wait.ts";
import { SubagentActivity, type SubagentActivityProps } from "./chat-subagent-activity.ts";

function matchesRun(row: ChatSubagentActivityRow, digest: SessionObserverDigest): boolean {
  const session = row.session;
  return (
    row.status === "running" &&
    areUiSessionKeysEquivalent(row.key, digest.sessionKey) &&
    typeof digest.runId === "string" &&
    session.activeRunIds?.includes(digest.runId) === true &&
    (!digest.agentId ||
      normalizeAgentId(digest.agentId) === resolveUiSessionRowAgentId(session, "")) &&
    (!digest.sessionId || digest.sessionId === session.sessionId) &&
    (!digest.lifecycleRevision || digest.lifecycleRevision === session.lifecycleRevision)
  );
}

/** A view cache of the broad session observer stream, not a child-history subscriber. */
function SubagentActivityLive(props: SubagentActivityProps) {
  const context = useOptionalApplication();
  const digests = new Map<string, SessionObserverDigest>();
  const [revision, setRevision] = createSignal(0);
  createEffect(
    () => props.rows,
    (rows) => {
      for (const [key, digest] of digests) {
        if (!rows.some((row) => row.key === key && matchesRun(row, digest))) {
          digests.delete(key);
        }
      }
    },
  );
  onSettled(() => {
    if (!context) {
      return undefined;
    }
    const gateway = context.gateway;
    let connection = gateway.snapshot.hello;
    const changed = () => setRevision((value) => value + 1);
    const unsubscribe = gateway.subscribe(() => {
      if (connection !== gateway.snapshot.hello) {
        connection = gateway.snapshot.hello;
        digests.clear();
        changed();
      }
    });
    function onSessionObserver(event: GatewayEventFrame) {
      if (
        event.event !== "session.observer" ||
        !connection ||
        connection !== gateway.snapshot.hello ||
        !Value.Check(SessionObserverDigestSchema, event.payload)
      ) {
        return;
      }
      const digest = event.payload;
      const row = untrack(() => props.rows).find((candidate) => matchesRun(candidate, digest));
      if (!row || pickFreshestObserverDigest(digests.get(row.key), digest) !== digest) {
        return;
      }
      digests.set(row.key, digest);
      changed();
    }
    const unsubscribeEvents = gateway.subscribeEvents(onSessionObserver);
    return () => {
      unsubscribe();
      unsubscribeEvents();
      digests.clear();
    };
  });
  const rows = () => {
    revision();
    return props.rows.map((row) => {
      const live = digests.get(row.key);
      if (!live || !matchesRun(row, live)) {
        return row;
      }
      const stored = row.session.observerDigest;
      const digest = pickFreshestObserverDigest(
        live,
        stored?.runId === live.runId ? stored : undefined,
      );
      return { ...row, activity: digest?.headline.trim() || undefined };
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
          "prop:turnStartedAt"?: SubagentActivityProps["turnStartedAt"];
          "prop:onOpenSubagent"?: SubagentActivityProps["onOpenSubagent"];
          "prop:onOpenSession"?: SubagentActivityProps["onOpenSession"];
        };
    }
  }
}
