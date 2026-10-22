import { createMemo, createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsCatalogResult, ToolsEffectiveResult } from "../../api/types.ts";
import { readToolsEffective } from "../../lib/agents/index.ts";

type ReadScope = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
};
type ReadOptions = {
  scope: () => ReadScope;
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
  function ensure(agentId: string) {
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
  }
  function reset() {
    target = null;
    accepted = null;
    setRequest(null);
  }
  return {
    read,
    request,
    ensure,
    reset,
    invalidate() {
      if (target !== accepted) {
        reset();
      }
    },
  };
}

type EffectiveRequest = CatalogRequest & { sessionKey: string; key: string };

export function createAgentEffectiveTools(
  options: ReadOptions & {
    key: (agentId: string, sessionKey: string) => string;
    changed: () => void;
  },
) {
  let target: EffectiveRequest | null = null;
  let accepted: EffectiveRequest | null = null;
  let cached: ToolsEffectiveResult | null = null;
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
  function ensure(agentId: string, sessionKey: string, refresh = false) {
    const { client, connected, requestGeneration: generation } = options.scope();
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
      (!refresh || target !== accepted)
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
  };
}
