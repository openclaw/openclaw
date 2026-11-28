import { createMemo, For } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";

export function createAttachedSessionName(client: () => GatewayBrowserClient | null | undefined) {
  const sessions = useOptionalApplication()?.sessions;
  const roster = sessions && projectOwner(sessions, (owner) => owner);
  const rows = createMemo(
    () => {
      const gateway = client();
      const owner = roster?.read();
      return gateway &&
        owner?.canonicalListReady &&
        !owner.state.resultCached &&
        owner.captureConnectionScope()?.client === gateway
        ? owner.state.result?.sessions
        : undefined;
    },
    { lazy: true },
  );
  const byGeneration = createMemo(
    () => {
      // Inventory contains generation IDs, not reusable routing keys.
      const index = new Map<string, GatewaySessionRow>();
      for (const row of rows() ?? []) {
        if (row.sessionId) {
          index.set(row.sessionId, row);
        }
      }
      return index;
    },
    { lazy: true },
  );
  return (sessionId: string) => {
    const row = byGeneration().get(sessionId);
    return row ? resolveSessionDisplayName(row.key, row) : undefined;
  };
}

export function DesktopAttachedSessions(props: {
  sessionIds: readonly string[] | undefined;
  nameFor: (sessionId: string) => string | undefined;
}) {
  return (
    <div class="desktop-environment__sessions">
      <For each={props.sessionIds} keyed={(sessionId) => sessionId}>
        {(sessionId) => {
          const name = createMemo(() => props.nameFor(sessionId()));
          const label = () => name() ?? sessionId();
          return (
            <span
              class="desktop-session"
              data-identifier={name() === undefined ? "true" : undefined}
              title={label()}
            >
              <bdi dir={name() === undefined ? "ltr" : undefined}>{label()}</bdi>
            </span>
          );
        }}
      </For>
    </div>
  );
}
