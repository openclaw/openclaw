import { createMemo, createStore, onSettled } from "solid-js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayEventFrame } from "../../../api/gateway.ts";
import { pickFreshestObserverDigest } from "../../../lib/observer-digest.ts";
import { isSessionObserverDigest } from "../../../lib/protocol-validators.generated/activity.js";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  resolveUiSessionRowAgentId,
} from "../../../lib/sessions/session-key.ts";
import type { ChatSubagentActivity as ChatSubagentActivityRow } from "../chat-subagent-wait.ts";
import { SubagentActivity, type SubagentActivityProps } from "./chat-subagent-activity.tsx";

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

/** Details consumes current observer digests without reading child history. */
export function ChatSubagentActivity(props: SubagentActivityProps) {
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
  onSettled(() => {
    if (!context) {
      return undefined;
    }
    const gateway = context.gateway;
    let connection = gateway.snapshot.hello;
    // Clear prior-connection digests before the next observer frame can be accepted.
    const unsubscribe = gateway.subscribe(() => {
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
      setDigests((draft) => {
        if (pickFreshestObserverDigest(draft[row.key], digest) === digest) {
          draft[row.key] = digest;
        }
      });
    }
    const unsubscribeEvents = gateway.subscribeEvents(onSessionObserver);
    return () => {
      unsubscribe();
      unsubscribeEvents();
    };
  });
  const rows = createMemo(() => {
    const value = props.rows.map((row) => {
      const live = digests[row.key];
      const stored = row.session.observerDigest;
      const digest = pickFreshestObserverDigest(
        live && matchesRun(row, live) ? live : undefined,
        stored?.runId && row.session.activeRunIds?.includes(stored.runId) ? stored : undefined,
      );
      return {
        ...row,
        activity: digest?.headline.trim() || row.activity,
        // Session rows omit plan steps, so only a winning live digest carries them.
        progress:
          live && digest === live && live.planProgress?.total ? live.planProgress : undefined,
      };
    });
    onSettled(() => {
      if (!props.presentation) {
        props.onPresentation?.(value);
      }
    });
    return value;
  });
  return <SubagentActivity {...props} rows={rows()} />;
}
