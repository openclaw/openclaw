import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal } from "solid-js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  buildToolsEffectiveRequestKey,
  readToolsEffective,
  type AgentsState,
} from "../../lib/agents/index.ts";
import { canCallGatewayMethod, canPresentGatewayMethod } from "../../lib/gateway-methods.ts";
import { modelCatalogEventInvalidation } from "../../lib/model-catalog-cache.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
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
    target === current &&
    options.canRead() &&
    options.isCurrent(current.client, current.generation, current.agentId);
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
  let presentationScope: EffectiveRequest | null = null;
  let cached: ToolsEffectiveResult | null = null;
  let refreshPending = false;
  const [request, setRequest] = createSignal<{
    result: Promise<ToolsEffectiveResult | null>;
    scope: EffectiveRequest;
  } | null>(null);
  const isCurrent = (current: EffectiveRequest) =>
    target === current &&
    options.canRead() &&
    options.isCurrent(current.client, current.generation, current.agentId);
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
      accepted = null;
      cached = null;
      options.changed();
      throw error;
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
      presentationScope = null;
    }
    target = { client, generation, agentId: resolvedAgentId, sessionKey: resolvedSessionKey, key };
    const result = load(target);
    void result.catch(() => undefined);
    // Same-query refreshes retain informational rows, not verified permission facts.
    presentationScope ??= target;
    setRequest({ result, scope: presentationScope });
  }
  function reset() {
    target = null;
    accepted = null;
    presentationScope = null;
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

export function createAgentToolsReads(options: {
  getGateway: () => ApplicationContext["gateway"];
  scope: () => EffectiveReadScope &
    Pick<AgentsState, "agentsPanel" | "chatModelCatalog" | "sessions" | "sessionsResult">;
  isCurrent: ReadOptions["isCurrent"];
  isSessionAgent: (agentId: string) => boolean;
  changed: () => void;
}) {
  const { getGateway, scope, isCurrent, isSessionAgent, changed } = options;
  const canRead = (method: string) =>
    canCallGatewayMethod(getGateway().snapshot, method, "operator.read");
  const toolsCatalog = createAgentToolsCatalog({
    scope,
    canRead: () => canPresentGatewayMethod(getGateway().snapshot, "tools.catalog", "operator.read"),
    isCurrent,
  });
  const effectiveTools = createAgentEffectiveTools({
    scope,
    canRead: () =>
      canPresentGatewayMethod(getGateway().snapshot, "tools.effective", "operator.read"),
    isCurrent,
    isSessionAgent,
    isPresented: () => scope().agentsPanel === "tools",
    key: (agentId, sessionKey) => buildToolsEffectiveRequestKey(scope(), { agentId, sessionKey }),
    changed,
  });
  type ToolPreviewSession = {
    client: GatewayBrowserClient;
    generation: number;
    agentId: string;
    key: string;
    title?: string;
  };
  let toolPreviewSession: ToolPreviewSession | null = null;
  function toolPreviewSessionTarget() {
    const state = options.scope();
    const {
      client,
      agentsSelectedId: agentId,
      sessionKey: key,
      requestGeneration: generation,
    } = state;
    return client &&
      agentId &&
      options.isCurrent(client, generation, agentId) &&
      state.agentsPanel === "tools" &&
      options.isSessionAgent(agentId) &&
      key &&
      canRead("tools.effective") &&
      canRead("sessions.describe")
      ? { client, agentId, key, generation }
      : null;
  }

  function toolPreviewSessionMatches(key: string, agentId?: string | null) {
    const target = toolPreviewSessionTarget();
    return Boolean(
      target &&
      uiConversationMatches(
        { agentsList: scope().agentsList, hello: getGateway().snapshot.hello },
        target.key,
        key,
        agentId,
        target.agentId,
      ),
    );
  }

  function resolveToolPreviewTitle(
    key: string,
    row: Parameters<typeof resolveSessionDisplayName>[1],
  ) {
    return [row?.label, row?.displayName, row?.derivedTitle].some(
      (name) => name?.trim() && name.trim() !== key,
    )
      ? resolveSessionDisplayName(key, row)
      : undefined;
  }

  function syncToolPreviewSession(refresh = false) {
    const target = toolPreviewSessionTarget();
    if (
      !refresh &&
      target &&
      toolPreviewSession?.client === target.client &&
      toolPreviewSession.generation === target.generation &&
      toolPreviewSession.agentId === target.agentId &&
      toolPreviewSession.key === target.key
    ) {
      return;
    }
    toolPreviewSession = null;
    if (!target || document.visibilityState === "hidden") {
      return;
    }
    // Read only the preview target; a roster window may not contain it.
    const read: ToolPreviewSession = target;
    toolPreviewSession = read;
    void read.client
      .request<{ session: GatewaySessionRow | null }>("sessions.describe", {
        key: read.key,
        agentId: read.agentId,
      })
      .then(
        ({ session }) => {
          if (
            toolPreviewSession !== read ||
            !session ||
            !toolPreviewSessionMatches(session.key, session.agentId ?? read.agentId)
          ) {
            return;
          }
          read.title = resolveToolPreviewTitle(session.key, session);
          if (read.title) {
            options.changed();
          }
        },
        () => undefined,
      );
  }

  const previewSession = {
    get title() {
      return toolPreviewSession?.title;
    },
    ensure: syncToolPreviewSession,
    onEvent(event: GatewayEventFrame) {
      if (event.event === "sessions.changed" && toolPreviewSessionTarget()) {
        const change = readSessionChangedEvent(event.payload);
        const payload = asNullableRecord(event.payload);
        const reason = payload?.reason;
        // Revoked sharing may suppress the keyed event for this connection.
        const unkeyedRemoval = !change && (reason === "sharing" || reason === "delete");
        const patchChangesTitle =
          change?.reason === "patch" &&
          payload &&
          "label" in payload &&
          "displayName" in payload &&
          resolveToolPreviewTitle(change.key, {
            label: typeof payload.label === "string" ? payload.label : undefined,
            displayName: typeof payload.displayName === "string" ? payload.displayName : undefined,
          }) !== toolPreviewSession?.title;
        if (
          unkeyedRemoval ||
          (change &&
            toolPreviewSessionMatches(change.key, change.agentId) &&
            (patchChangesTitle ||
              ["chat.title", "title", "reset", "delete", "sharing", "move"].includes(
                change.reason ?? "",
              )))
        ) {
          syncToolPreviewSession(true);
          options.changed();
        }
      }
    },
  };
  return { toolsCatalog, effectiveTools, previewSession };
}
