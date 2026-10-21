import type { SessionsDiffResult } from "../../../packages/gateway-protocol/src/index.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { listen } from "./reactive/listener.ts";

type Summary = { fileCount: number; additions: number; deletions: number; truncated: boolean };
type Snapshot = { summary: Summary | null; stale: boolean; unavailable: boolean };
type Entry = Snapshot & { checkedAt?: number };
type Input = {
  gateway: ApplicationGateway | undefined;
  sessionKey: string;
  agentId?: string;
  sessionId?: string;
  presented: boolean;
  runActive: boolean;
};
const empty = (): Entry => ({ summary: null, stale: false, unavailable: false });

export function createSessionDiffSummary(document: Document, isConnected = () => true) {
  let input: Input | undefined;
  let gateway: ApplicationGateway | undefined;
  let scope = 0;
  let lifecycle: ReturnType<typeof createGatewayConnectionLifecycle> | undefined;
  let unsubscribe: (() => void) | undefined;
  let current = empty();
  const entries = new Map<string, Entry>();
  let render: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let disposed = false;
  const publish = () => {
    render?.();
  };
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  function select() {
    const nextScope = gateway ? gatewayPresentationScope(gateway).key : 0;
    if (scope !== nextScope) {
      entries.clear();
      scope = nextScope;
    }
    const key = JSON.stringify([input?.sessionKey, input?.agentId, input?.sessionId]);
    let entry = entries.get(key);
    if (!entry) {
      entry = empty();
      entries.set(key, entry);
    }
    if (current !== entry) {
      current = entry;
      publish();
    }
    // Retained panes may be reused across navigation; don't retain every visited session.
    if (entries.size > 16) {
      entries.delete(entries.keys().next().value!);
    }
  }

  function schedule() {
    clearTimer();
    if (
      disposed ||
      !input?.presented ||
      !gateway ||
      document.visibilityState === "hidden" ||
      gateway.snapshot.phase !== "connected" ||
      !gateway.snapshot.client ||
      !input.sessionKey ||
      pending
    ) {
      return;
    }
    const interval = input.runActive ? 5_000 : 30_000;
    const delay =
      current.checkedAt === undefined ? 0 : Math.max(0, current.checkedAt + interval - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, delay);
  }

  async function refresh() {
    const connection = lifecycle?.capture();
    if (
      !connection ||
      !input?.presented ||
      !gateway ||
      disposed ||
      !isConnected() ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const source = gateway;
    const owner = current;
    const ownerScope = scope;
    const target = {
      sessionKey: input.sessionKey,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      scope: "all",
      summaryOnly: true,
    };
    const connectionOwner = lifecycle;
    const isCurrent = () =>
      !disposed &&
      gateway === source &&
      current === owner &&
      gatewayPresentationScope(source).key === ownerScope &&
      connectionOwner?.isCurrent(connection);
    pending = true;
    try {
      const result = await connection.client.request<SessionsDiffResult>("sessions.diff", target);
      if (!isCurrent()) {
        return;
      }
      if (result.unavailableReason) {
        owner.unavailable = true;
        owner.stale = owner.summary !== null;
      } else {
        owner.summary = {
          fileCount: result.files.length,
          additions: result.additions,
          deletions: result.deletions,
          truncated: result.truncated === true,
        };
        owner.unavailable = false;
        owner.stale = false;
      }
    } catch {
      if (!isCurrent()) {
        return;
      }
      owner.unavailable = true;
      owner.stale = owner.summary !== null;
    } finally {
      pending = false;
      if (isCurrent()) {
        owner.checkedAt = Date.now();
        publish();
      }
      schedule();
    }
  }

  function connectionChanged() {
    if (!gateway) {
      return;
    }
    select();
    if (lifecycle?.transition(gateway.snapshot)) {
      for (const entry of entries.values()) {
        entry.checkedAt = undefined;
        entry.stale = entry.summary !== null;
      }
      publish();
    }
    schedule();
  }
  const stopVisibility = listen(document, "visibilitychange", schedule);
  return {
    get snapshot(): Snapshot {
      return current;
    },
    subscribe(listener: () => void) {
      render = listener;
      return () => {
        render = undefined;
      };
    },
    update(next: Input) {
      if (disposed) {
        return;
      }
      input = next;
      if (gateway !== next.gateway) {
        unsubscribe?.();
        lifecycle?.dispose();
        entries.clear();
        gateway = next.gateway;
        lifecycle = gateway ? createGatewayConnectionLifecycle(gateway.snapshot) : undefined;
        // Gateway receipts invalidate this Details metadata cache; the full Review diff has a separate lifetime.
        unsubscribe = gateway?.subscribe(connectionChanged);
      }
      select();
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimer();
      unsubscribe?.();
      lifecycle?.dispose();
      stopVisibility();
      entries.clear();
      render = undefined;
    },
  };
}
