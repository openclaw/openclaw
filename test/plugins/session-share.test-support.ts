import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import sessionSharePlugin from "../../extensions/session-share/index.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../../src/plugins/registry-runtime.test-helpers.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";

type SessionPage = { sessions: SessionCatalogSession[]; nextCursor?: string };
type TranscriptPage = {
  threadId: string;
  items: SessionCatalogTranscriptItem[];
  nextCursor?: string;
};

export function commandFixture(groups: string[] = ["Team"]) {
  const config: OpenClawConfig = {
    plugins: { entries: { "session-share": { enabled: true, config: { share: { groups } } } } },
  };
  setRuntimeConfigSnapshot(config);
  const runtime = createPluginRuntime();
  runtime.config.current = () => config;
  const registry = createRuntimeTestRegistry(runtime);
  const api = registry.createApi(
    createPluginRecord({
      id: "session-share",
      source: "/plugins/session-share/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    }),
    { config },
  );
  sessionSharePlugin.register(api);
  const commands = registry.registry.nodeHostCommands.map((entry) => entry.command);
  const list = commands.find((command) => command.command === "openclaw.sessions.list.v1")!;
  const read = commands.find((command) => command.command === "openclaw.sessions.read.v1")!;
  return {
    config,
    runtime,
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
