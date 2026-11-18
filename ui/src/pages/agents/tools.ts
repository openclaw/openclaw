import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ToolsCatalogResult, ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readToolsEffective, type AgentsState } from "../../lib/agents/index.ts";
import { modelCatalogEventInvalidation } from "../../lib/model-catalog-cache.ts";
import {
  uiConversationMatches,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import {
  readSessionChangedEvent,
  sessionChangedSnapshots,
} from "../../lib/sessions/session-row-reconcile.ts";

function agentEffectiveToolsEventInvalidates(
  event: GatewayEventFrame,
  scope: UiSessionDefaultsHost & { agentId: string; sessionKey: string },
): boolean {
  if (event.event === "chat.metadata.changed") {
    const payload = asNullableRecord(event.payload);
    // Auth receipts also certify executable catalog identity; picker observations preserve it.
    if (
      payload?.authChanged === false &&
      payload.commandsChanged === false &&
      payload.modelSelectionChanged !== true
    ) {
      return false;
    }
  }
  return Boolean(
    modelCatalogEventInvalidation(event, { agentId: scope.agentId }) ||
    (event.event === "sessions.changed" &&
      sessionChangedSnapshots(event.payload).some((snapshot) => {
        const change = readSessionChangedEvent(snapshot);
        return (
          !change ||
          uiConversationMatches(scope, scope.sessionKey, change.key, change.agentId, scope.agentId)
        );
      })),
  );
}

type ReadOptions = {
  canRead: () => boolean;
  scope: () => {
    client: GatewayBrowserClient | null;
    connected: boolean;
    requestGeneration: number;
  };
  isCurrent: (client: GatewayBrowserClient, generation: number, agentId: string) => boolean;
  changed: () => void;
};
type CatalogRequest = {
  client: GatewayBrowserClient;
  generation: number;
  agentId: string;
};

export function createAgentToolsCatalog(options: ReadOptions) {
  let target: CatalogRequest | null = null;
  let accepted: CatalogRequest | null = null;
  let result: ToolsCatalogResult | null = null;
  let failed = false;
  const isCurrent = (current: CatalogRequest) =>
    target === current &&
    options.canRead() &&
    options.isCurrent(current.client, current.generation, current.agentId);
  async function load(current: CatalogRequest) {
    try {
      const next = await current.client.request<ToolsCatalogResult>("tools.catalog", {
        agentId: current.agentId,
        includePlugins: true,
      });
      if (!isCurrent(current)) {
        return;
      }
      accepted = current;
      result = next;
      options.changed();
    } catch {
      if (!isCurrent(current)) {
        return;
      }
      target = null;
      failed = true;
      options.changed();
    }
  }
  function reset() {
    target = null;
    accepted = null;
    result = null;
    failed = false;
    options.changed();
  }
  return {
    read: () => ({ result, pending: target !== accepted, failed }),
    ensure(agentId: string) {
      if (!options.canRead()) {
        reset();
        return;
      }
      const { client, connected, requestGeneration: generation } = options.scope();
      if (!client || !connected) {
        return;
      }
      if (
        target?.client === client &&
        target.agentId === agentId &&
        (target.generation === generation || target === accepted)
      ) {
        return;
      }
      accepted = null;
      target = { client, generation, agentId };
      result = null;
      failed = false;
      options.changed();
      void load(target);
    },
    reset,
    invalidate() {
      if (target !== accepted) {
        reset();
      }
    },
  };
}

type EffectiveRequest = CatalogRequest & { sessionKey: string; key: string };
type EffectiveReadScope = Pick<
  AgentsState,
  "client" | "connected" | "requestGeneration" | "agentsSelectedId" | "agentsList"
> & { sessionKey: string };

export function createAgentEffectiveTools(
  options: Omit<ReadOptions, "scope"> & {
    scope: () => EffectiveReadScope;
    isSessionAgent: (agentId: string) => boolean;
    isPresented: () => boolean;
    key: (agentId: string, sessionKey: string) => string;
  },
) {
  let target: EffectiveRequest | null = null;
  let accepted: EffectiveRequest | null = null;
  let cached: ToolsEffectiveResult | null = null;
  let refreshPending = false;
  let failed = false;
  const isCurrent = (current: EffectiveRequest) =>
    target === current &&
    options.canRead() &&
    options.isCurrent(current.client, current.generation, current.agentId);
  async function load(current: EffectiveRequest) {
    try {
      const result = await readToolsEffective(current.client, {
        agentId: current.agentId,
        sessionKey: current.sessionKey,
      });
      if (!isCurrent(current)) {
        return;
      }
      accepted = current;
      cached = result;
      options.changed();
    } catch {
      if (!isCurrent(current)) {
        return;
      }
      target = null;
      accepted = null;
      cached = null;
      failed = true;
      options.changed();
    }
  }
  function ensure(refresh = false) {
    if (!options.canRead()) {
      reset();
      return;
    }
    const {
      client,
      connected,
      requestGeneration: generation,
      agentsSelectedId: agentId,
      sessionKey,
    } = options.scope();
    if (!agentId) {
      return;
    }
    if (!options.isSessionAgent(agentId)) {
      reset();
      return;
    }
    refreshPending ||= refresh;
    if (!options.isPresented() || document.visibilityState === "hidden") {
      return;
    }
    const force = refreshPending;
    refreshPending = false;
    const resolvedAgentId = agentId.trim();
    const resolvedSessionKey = sessionKey.trim();
    if (!client || !connected || !resolvedAgentId || !resolvedSessionKey) {
      return;
    }
    const key = options.key(resolvedAgentId, resolvedSessionKey);
    if (
      target?.client === client &&
      target.generation === generation &&
      target.key === key &&
      (!force || target !== accepted)
    ) {
      return;
    }
    const previous = target ?? accepted;
    if (previous?.client !== client || previous.generation !== generation || previous.key !== key) {
      cached = null;
    }
    target = { client, generation, agentId: resolvedAgentId, sessionKey: resolvedSessionKey, key };
    failed = false;
    options.changed();
    void load(target);
  }
  function reset() {
    target = null;
    accepted = null;
    cached = null;
    refreshPending = false;
    failed = false;
    options.changed();
  }
  return {
    read: () => ({ result: cached, pending: target !== accepted, failed }),
    ensure,
    reset,
    subscribe(gateway: Pick<ApplicationContext["gateway"], "subscribeEvents" | "snapshot">) {
      return gateway.subscribeEvents((event) => {
        const scope = options.scope();
        const agentId = scope.agentsSelectedId;
        if (
          agentId &&
          agentEffectiveToolsEventInvalidates(event, {
            agentId,
            sessionKey: scope.sessionKey,
            agentsList: scope.agentsList,
            hello: gateway.snapshot.hello,
          })
        ) {
          ensure(true);
        }
      });
    },
  };
}
