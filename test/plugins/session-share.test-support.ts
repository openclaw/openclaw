import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type {
  SessionCatalogProvider,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import sessionSharePlugin from "../../extensions/session-share/index.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";

export function registerSessionShare(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
  const catalogs: SessionCatalogProvider[] = [];
  const services: OpenClawPluginService[] = [];
  const api = createTestPluginApi({
    runtime,
    config,
    registerNodeHostCommand: (command) => {
      nodeCommands.push(command);
    },
    registerSessionCatalog: (catalog) => {
      catalogs.push(catalog);
    },
    registerService: (service) => {
      services.push(service);
    },
  });
  sessionSharePlugin.register(api);
  const catalog = catalogs.find((entry) => entry.id === "openclaw");
  if (!catalog) {
    throw new Error("Session Share did not register its catalog");
  }
  return { commands: nodeCommands, catalog, services, logger: api.logger };
}

export type SessionPage = { sessions: SessionCatalogSession[]; nextCursor?: string };
type TranscriptPage = {
  threadId: string;
  items: SessionCatalogTranscriptItem[];
  nextCursor?: string;
};

export function commandFixture(groups: string[] = ["Team"]) {
  const config: OpenClawConfig = {
    plugins: { entries: { "session-share": { enabled: true, config: { share: { groups } } } } },
  };
  const runtime = createPluginRuntime();
  runtime.config.current = () => config;
  const commands = registerSessionShare(runtime, config).commands;
  const list = commands.find((command) => command.command === "openclaw.sessions.list.v1")!;
  const read = commands.find((command) => command.command === "openclaw.sessions.read.v1")!;
  return {
    config,
    commands,
    select: (share: unknown) => {
      config.plugins!.entries!["session-share"]!.config = { share };
    },
    list: async (params: Record<string, unknown> = {}) =>
      JSON.parse(await list.handle(JSON.stringify(params))) as SessionPage,
    read: async (threadId: string, params: Record<string, unknown> = {}) =>
      JSON.parse(await read.handle(JSON.stringify({ threadId, ...params }))) as TranscriptPage,
  };
}
