import { vi } from "vitest";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

type Resolve =
  typeof import("./get-reply-native-slash-fast-path.js").maybeResolveNativeSlashCommandFastReply;
type Params = Parameters<Resolve>[0];

export function createNativeModelCatalog(
  anthropicReasoning = false,
): ModelCatalogSnapshot["entries"] {
  return (
    [
      ["openai", "gpt-5.5", "GPT", 400_000, false],
      ["anthropic", "claude-fable-5", "Fable", 1_000_000, anthropicReasoning],
    ] as const
  ).map(([provider, id, name, contextWindow, reasoning]) => ({
    provider,
    id,
    name,
    contextWindow,
    reasoning,
  }));
}

export function nativeCommand(body: string, overrides: Parameters<typeof buildTestCtx>[0] = {}) {
  const authorized = overrides.CommandAuthorized ?? true;
  return buildTestCtx({
    Body: body,
    CommandBody: body,
    CommandSource: "native",
    CommandAuthorized: authorized,
    CommandTurn: {
      kind: "native",
      source: "native",
      authorized,
      commandName: body.slice(1).split(/\s+/, 1)[0] ?? "",
      body,
    },
    ...overrides,
  });
}

export function createNativeSlashFixture(storePath: string, resolve: Resolve) {
  const typing: TypingController = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
  const address = (sessionKey = "agent:main:telegram:123", agentId = "main") => ({
    storePath,
    sessionKey,
    agentId,
  });
  const config = (
    cfg: Params["cfg"] = {},
    options?: Parameters<typeof markCompleteReplyConfig>[1],
  ) => markCompleteReplyConfig({ session: { store: storePath }, ...cfg }, options);
  return {
    storePath,
    typing,
    config,
    readExact: (sessionKey?: string) => loadExactSessionEntry(address(sessionKey)),
    read: (sessionKey: string) => loadSessionEntry(address(sessionKey)),
    write: (entry: SessionEntry, sessionKey?: string, agentId?: string) =>
      replaceSessionEntry(address(sessionKey, agentId), entry),
    run: (overrides: Pick<Params, "ctx"> & Partial<Params>) =>
      resolve({
        agentId: "main",
        agentDir: "/tmp/agent",
        agentCfg: undefined,
        commandAuthorized: true,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        provider: "openai",
        model: "gpt-5.5",
        aliasIndex: { byKey: new Map(), byAlias: new Map() },
        workspaceDir: "/tmp/workspace",
        typing,
        cfg: config(),
        ...overrides,
      }),
  };
}
