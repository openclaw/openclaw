import type { ChatMetadataParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  buildHomeWorkContext,
  subscribeChatWorkContext,
} from "../../pages/chat/chat-work-context.ts";
import {
  pluginHelpState,
  subscribePluginHelp,
  type PluginHelpContext,
} from "../../pages/custodian/plugin-help-state.ts";
import { acquirePaletteIdentityPreferences } from "../../pages/new-session/palette-identity-preferences.ts";
import { peekChatMetadata, subscribeChatMetadata } from "../chat/chat-metadata-store.ts";
import { readMcpAppContexts, subscribeMcpAppContexts } from "../mcp-app-context.ts";
import type { ModelCatalogClient, ModelCatalogReadScope } from "../model-catalog-cache.ts";
import { readModelCatalog, subscribeModelCatalogCache } from "../model-catalog-store.ts";
import { projectSource } from "./projection.ts";

export type ModelCatalogSource = {
  client: ModelCatalogClient | null | undefined;
  scope: ModelCatalogReadScope | null | undefined;
};

/** Catalog owners retain stale display snapshots while retiring mutation authority. */
export function projectModelCatalog(source: ModelCatalogSource) {
  return projectSource(source, {
    read: ({ client, scope }) => readModelCatalog(client, scope),
    subscribe: ({ client }, notify) =>
      client ? subscribeModelCatalogCache(client, notify) : () => {},
    equality: "revision",
  });
}

export type ChatMetadataSource = {
  client: GatewayBrowserClient;
  scope: ChatMetadataParams;
  isActive?: () => boolean;
};

export function projectChatMetadata(source: ChatMetadataSource) {
  return projectSource(source, {
    read: ({ client, scope }) => peekChatMetadata(client, scope),
    subscribe: ({ client, scope, isActive }, notify) =>
      subscribeChatMetadata(client, scope, notify, isActive),
    equality: "revision",
  });
}

export type McpAppContextSource = {
  client: Parameters<typeof readMcpAppContexts>[0];
  sessionKey: string;
  agentId: string;
};

export function projectMcpAppContexts(source: McpAppContextSource) {
  return projectSource(source, {
    read: ({ client, sessionKey, agentId }) => readMcpAppContexts(client, sessionKey, agentId),
    subscribe: ({ client }, notify) =>
      client ? subscribeMcpAppContexts(client, notify) : () => {},
    equality: "revision",
  });
}

export type ChatWorkContextSource = {
  context: Parameters<typeof buildHomeWorkContext>[0];
  page: string;
  sessionKey: string;
  agentId: string;
};

export function projectChatWorkContext(source: ChatWorkContextSource) {
  return projectSource(source, {
    read: ({ context, page, sessionKey, agentId }) =>
      buildHomeWorkContext(context, page, sessionKey, agentId),
    subscribe: ({ context }, notify) => {
      const releases = [
        subscribeChatWorkContext(context, notify),
        context.gateway.subscribe(notify),
        context.agents.subscribe(notify),
        context.sessions.subscribe(notify),
      ];
      return () => releases.forEach((release) => release());
    },
    equality: "revision",
  });
}

/** Help state is mutable; the context owns its gateway and router subscriptions. */
export function projectPluginHelp(source: PluginHelpContext) {
  return projectSource(source, {
    read: pluginHelpState,
    subscribe: subscribePluginHelp,
    equality: "revision",
  });
}

export type PaletteIdentitySource = {
  owner: Parameters<typeof acquirePaletteIdentityPreferences>[0];
  isCurrent: () => boolean;
};

/** Keep the owner's live authority predicate, including while writes await completion. */
export function projectPaletteIdentityPreferences(source: PaletteIdentitySource) {
  type Preferences = ReturnType<typeof acquirePaletteIdentityPreferences>;
  type Snapshot = Pick<Preferences, "mode" | "palettePreference">;
  return projectSource(source, {
    // A temporary non-current binding samples the existing owner without starting reads.
    read: (current): Snapshot => {
      const preferences = acquirePaletteIdentityPreferences(current.owner);
      const release = preferences.subscribe(
        () => {},
        () => false,
      );
      const snapshot = {
        mode: preferences.mode,
        palettePreference: preferences.palettePreference,
      };
      release();
      return snapshot;
    },
    subscribe: (current, notify) => {
      const preferences = acquirePaletteIdentityPreferences(current.owner);
      return preferences.subscribe(notify, current.isCurrent);
    },
    equality: "revision",
  });
}
