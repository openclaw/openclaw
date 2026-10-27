import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal } from "solid-js";
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
  scope: () => {
    client: GatewayBrowserClient | null;
    connected: boolean;
    requestGeneration: number;
  };
  isCurrent: (client: GatewayBrowserClient, generation: number, agentId: string) => boolean;
};
type CatalogRequest = {
  client: GatewayBrowserClient;
  generation: number;
  agentId: string;
};

export function createAgentToolsCatalog(options: ReadOptions) {
  let target: CatalogRequest | null = null;
  let accepted: CatalogRequest | null = null;
  const [request, setRequest] = createSignal<{
    result: Promise<ToolsCatalogResult | null>;
  } | null>(null);
  const isCurrent = (current: CatalogRequest) =>
    target === current && options.isCurrent(current.client, current.generation, current.agentId);
  const read: () => ToolsCatalogResult | null = createMemo(async () => request()?.result ?? null);
  async function load(current: CatalogRequest) {
    try {
      const result = await current.client.request<ToolsCatalogResult>("tools.catalog", {
        agentId: current.agentId,
        includePlugins: true,
      });
      if (!isCurrent(current)) {
        return null;
      }
      accepted = current;
      return result;
    } catch (error) {
      if (!isCurrent(current)) {
        return null;
      }
      target = null;
      throw error;
    }
  }
  function reset() {
    target = null;
    accepted = null;
    setRequest(null);
  }
  return {
    read,
    request,
    ensure(agentId: string) {
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
      const result = load(target);
      // A hidden panel can leave the receipt unobserved until it is revisited.
      void result.catch(() => undefined);
      setRequest({ result });
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
    changed: () => void;
  },
) {
  let target: EffectiveRequest | null = null;
  let accepted: EffectiveRequest | null = null;
  let cached: ToolsEffectiveResult | null = null;
  let refreshPending = false;
  const [request, setRequest] = createSignal<{
    result: Promise<ToolsEffectiveResult | null>;
  } | null>(null);
  const isCurrent = (current: EffectiveRequest) =>
    target === current && options.isCurrent(current.client, current.generation, current.agentId);
  const read: () => ToolsEffectiveResult | null = createMemo(async () => request()?.result ?? null);
  async function load(current: EffectiveRequest) {
    try {
      const result = await readToolsEffective(current.client, {
        agentId: current.agentId,
        sessionKey: current.sessionKey,
      });
      if (!isCurrent(current)) {
        return null;
      }
      accepted = current;
      // Ordering retains the accepted answer; availability consumes the native read.
      cached = result;
      options.changed();
      return result;
    } catch (error) {
      if (!isCurrent(current)) {
        return null;
      }
      target = null;
      throw error;
    }
  }
  function ensure(refresh = false) {
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
    const result = load(target);
    void result.catch(() => undefined);
    setRequest({ result });
  }
  function reset() {
    target = null;
    accepted = null;
    cached = null;
    refreshPending = false;
    setRequest(null);
  }
  return {
    read,
    get cached() {
      return cached;
    },
    request,
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
