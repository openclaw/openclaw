import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { registerPluginCommandInRegistry } from "../../plugins/command-registration.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandExecutionReplyOptions,
} from "../../plugins/plugin-command-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { buildCommandContextForTest as buildCommandContext } from "./commands-context.test-support.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";
import { shouldBypassPluginOwnedBindingForCommand } from "./dispatch-from-config.plugin-binding.js";
import { finalizeInboundContext } from "./inbound-context.js";

const compactEmbeddedAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-compact.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands-compact.runtime.js")>()),
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  isEmbeddedAgentRunAbortableForCompaction: () => false,
}));

// Cold runtime imports are setup work, not part of the compaction deadline.
await import("./commands-compact.runtime.js");

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-plugin-compact-");

type CompactCurrent = NonNullable<
  NonNullable<PluginCommandContext["runtimeContext"]>["compactCurrent"]
>;

let registry: PluginRegistry;

function registerTestCommand(
  result: PluginCommandResult | Parameters<typeof registerPluginCommandInRegistry>[2]["handler"] = {
    text: "from plugin",
  },
  overrides: Partial<Omit<Parameters<typeof registerPluginCommandInRegistry>[2], "handler">> = {},
) {
  const handler = vi.fn(
    typeof result === "function" ? result : async (_ctx: PluginCommandContext) => result,
  );
  const command = { name: "card", description: "Card command", handler, ...overrides };
  expect(registerPluginCommandInRegistry(registry, "test-plugin", command)).toEqual({ ok: true });
  return handler;
}

function firstCommandContext(handler: ReturnType<typeof registerTestCommand>) {
  return expectDefined(handler.mock.calls[0]?.[0], "plugin command handler context");
}

const sessionKey = "agent:main:whatsapp:direct:test-user";
const commandConfig: OpenClawConfig = { commands: { text: true } };
const channelConfig: OpenClawConfig = {
  ...commandConfig,
  channels: { whatsapp: { allowFrom: ["*"] } },
};

async function buildStoredPluginParams(lifecycleRevision?: string) {
  const tempDir = sessionDirs.make();
  const storePath = path.join(tempDir, "sessions.json");
  const entry = { sessionId: "session-plugin-command", updatedAt: Date.now(), lifecycleRevision };
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  const params = buildPluginParams("/card", { ...commandConfig, session: { store: storePath } });
  params.storePath = storePath;
  params.sessionStore = { [sessionKey]: entry };
  return { params, entry, storePath, tempDir };
}

const compactCommand = async (ctx: PluginCommandContext) => ({
  text: JSON.stringify(await ctx.runtimeContext?.compactCurrent?.()),
});

async function expectSessionChanged(params: HandleCommandsParams) {
  expect((await handlePluginCommand(params, true))?.reply?.text).toBe(
    JSON.stringify({ compacted: false, reason: "command session changed" }),
  );
  expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
}

function buildPluginParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = channelConfig,
): HandleCommandsParams {
  const params = buildPluginsCommandParams({
    commandBodyNormalized,
    cfg,
    workspaceDir: "/tmp/openclaw-plugin-command",
  });
  params.command.senderIsOwner = false;
  return Object.assign(params, {
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 10_000,
    isGroup: false,
    resolveDefaultThinkingLevel: async () => "medium" as const,
  });
}

function selectPluginCommand(body: string, cfg: OpenClawConfig) {
  const opts: NonNullable<HandleCommandsParams["opts"]> & PluginCommandExecutionReplyOptions = {};
  const ctx = finalizeInboundContext({
    Body: body,
    CommandAuthorized: true,
    CommandSource: "text",
    Provider: "whatsapp",
    Surface: "whatsapp",
  });
  expect(shouldBypassPluginOwnedBindingForCommand(ctx, cfg, opts)).toBe(true);
  expect(opts[PLUGIN_COMMAND_DISPATCH]?.kind).toBe("plugin");
  return opts;
}

async function withDeclaredCommandPlugin(run: (cfg: OpenClawConfig) => Promise<void>) {
  const tempDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-availability-")),
  );
  const pluginId = "recovery-controls";
  const pluginFile = path.join(tempDir, "index.cjs");
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: tempDir } },
    commands: { text: true },
    plugins: {
      allow: [pluginId],
      load: { paths: [pluginFile] },
      entries: { [pluginId]: { enabled: true } },
    },
  };
  try {
    await fs.writeFile(
      path.join(tempDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        commandAliases: [
          { name: "recover", kind: "runtime-slash", cliCommand: "plugins" },
          { name: "legacy-recover" },
        ],
      }),
    );
    await fs.writeFile(
      pluginFile,
      `module.exports = { id: "${pluginId}", register(api) {
        api.registerCommand({ name: "recover", description: "Recovery controls", acceptsArgs: true, handler: () => ({ text: "must be rolled back" }) });
        throw new Error("fixture registration failed\\n    at private loader frame");
      } };`,
    );
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(tempDir, "state"),
        OPENCLAW_CONFIG_PATH: path.join(tempDir, "openclaw.json"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      async () => {
        registry = loadOpenClawPlugins({
          config: cfg,
          workspaceDir: tempDir,
          cache: false,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        });
        await run(cfg);
      },
    );
  } finally {
    resetPluginRuntimeStateForTest();
    // Loaded instances and failed registrations both retain capture ownership.
    await expect(disposePluginRegistryInstances(registry)).resolves.toMatchObject({ failures: [] });
    await expect(waitForPluginCacheRetirement()).resolves.toMatchObject({ failures: [] });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  compactEmbeddedAgentSessionMock.mockReset();
  resetPluginRuntimeStateForTest();
  registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
});
afterEach(() => resetPluginRuntimeStateForTest());

it.each(["/randomtext", "/recover stop"])(
  "handles failed plugin availability for %s",
  async (body) => {
    await withDeclaredCommandPlugin(async (cfg) => {
      expect(registry.plugins.find((plugin) => plugin.id === "recovery-controls")?.status).toBe(
        "error",
      );
      const params = buildPluginParams(body, cfg);
      if (body === "/recover stop") {
        params.opts = selectPluginCommand(body, cfg);
      }
      const result = await handlePluginCommand(params, true);
      if (body === "/randomtext") {
        expect(result).toBeNull();
      } else {
        expect(result?.reply?.text).toContain("fixture registration failed");
        setActivePluginRegistry(createEmptyPluginRegistry());
        expect((await handlePluginCommand(params, true))?.reply?.text).toContain(
          "registry changed",
        );
      }
    });
  },
);

it("compacts the bound session through the host runtime and records fresh tokens", async () => {
  const { params, storePath, tempDir } = await buildStoredPluginParams();
  params.workspaceDir = tempDir;
  registerTestCommand(compactCommand);
  compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    compactionKind: "native-harness",
    result: { summary: "", firstKeptEntryId: "", tokensBefore: 900, tokensAfter: 321 },
  });

  const response = await handlePluginCommand(params, true);

  expect(response?.reply?.text).toBe(
    JSON.stringify({ compacted: true, tokensBefore: 900, tokensAfter: 321 }),
  );
  const freshTokens = { compactionCount: 1, totalTokens: 321, totalTokensFresh: true };
  expect(expectDefined(params.sessionStore, "session store")[sessionKey]).toMatchObject(
    freshTokens,
  );
  expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(freshTokens);
});

it("omits session compaction when no bound session exists", async () => {
  const handler = registerTestCommand();
  const params = buildPluginParams("/card", commandConfig);
  params.sessionEntry = undefined;

  await handlePluginCommand(params, true);

  expect(firstCommandContext(handler).runtimeContext?.compactCurrent).toBeUndefined();
});

it("blocks session compaction for an unauthorized public command", async () => {
  const handler = registerTestCommand(compactCommand, { requireAuth: false });
  const params = buildPluginParams("/card", commandConfig);
  params.command = { ...params.command, isAuthorizedSender: false };

  const result = await handlePluginCommand(params, true);

  expect(result?.reply?.text).toBe(
    JSON.stringify({ compacted: false, reason: "compaction requires authorization" }),
  );
  expect(
    expectDefined(handler.mock.calls[0]?.[0], "public command context").runtimeContext
      ?.compactCurrent,
  ).toBeTypeOf("function");
  expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
});

it.each(["retained", "unawaited"] as const)(
  "closes %s compaction after the handler settles",
  async (mode) => {
    const params =
      mode === "unawaited"
        ? (await buildStoredPluginParams()).params
        : buildPluginParams("/card", commandConfig);
    const preparation = createDeferredCore();
    let compact: CompactCurrent | undefined;
    let detached: ReturnType<CompactCurrent> | undefined;
    registerTestCommand(async (ctx) => {
      compact = ctx.runtimeContext?.compactCurrent;
      if (mode === "unawaited") {
        detached = expectDefined(compact, "compact capability")();
      }
      return { text: mode === "retained" ? "saved" : "started" };
    });
    if (mode === "unawaited") {
      params.resolveDefaultThinkingLevel = async () => {
        await preparation.promise;
        return "medium";
      };
    }
    try {
      await handlePluginCommand(params, true);
      preparation.resolve();
      const result =
        mode === "retained"
          ? expectDefined(compact, "retained compact capability")()
          : expectDefined(detached, "detached compact result");
      await expect(result).resolves.toEqual({
        compacted: false,
        reason: "command invocation closed",
      });
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    } finally {
      preparation.resolve();
    }
  },
);

it.each(["disappeared", "changed during admission", "replaced before invocation"] as const)(
  "rejects session compaction when the session is %s",
  async (change) => {
    const { params, entry, storePath } = await buildStoredPluginParams(
      change === "disappeared" ? undefined : "revision-1",
    );
    const replacement = {
      ...entry,
      sessionId: "replacement-session",
      lifecycleRevision: "revision-2",
    };
    if (change === "changed during admission") {
      params.resolveDefaultThinkingLevel = async () => {
        await replaceSessionEntry(
          { storePath, sessionKey },
          { ...entry, lifecycleRevision: "revision-2" },
        );
        return "medium";
      };
    }
    registerTestCommand(async (ctx) => {
      if (change === "disappeared") {
        await deleteSessionEntryLifecycle({
          storePath,
          archiveTranscript: false,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
      } else if (change === "replaced before invocation") {
        Object.assign(
          expectDefined(
            expectDefined(params.sessionStore, "session store")[sessionKey],
            "session entry",
          ),
          replacement,
        );
        await replaceSessionEntry({ storePath, sessionKey }, replacement);
      }
      return { text: JSON.stringify(await ctx.runtimeContext?.compactCurrent?.()) };
    });
    await expectSessionChanged(params);
    if (change === "replaced before invocation") {
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(replacement);
    }
  },
);

it.each(["incognito", "global"] as const)("resolves the %s command session store", async (mode) => {
  const handler = registerTestCommand();
  const params = buildPluginParams("/card", {
    ...commandConfig,
    session: { store: "/tmp/durable/{agentId}/sessions.json" },
  });
  params.agentId = mode === "global" ? "other" : "main";
  params.sessionKey =
    mode === "global" ? "global" : "agent:main:dashboard:incognito-plugin-command";
  if (mode === "incognito") {
    params.storePath = "/tmp/durable/main/sessions.json";
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "incognito-session",
        incognito: true,
        updatedAt: Date.now(),
      },
    };
  }
  await handlePluginCommand(params, true);
  const context = firstCommandContext(handler);
  if (mode === "incognito") {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(context.sessionTarget?.storePath).toBe(storePath);
    expect(parseSqliteSessionFileMarker(context.sessionFile)?.storePath).toBe(storePath);
  } else {
    expect(context.sessionTarget).toMatchObject({
      agentId: "other",
      storePath: "/tmp/durable/other/sessions.json",
    });
  }
});

it("enforces requiredScopes through the command handler path", async () => {
  const handler = registerTestCommand(
    { text: "approved", continueAgent: true },
    {
      name: "approve-deploy",
      requiredScopes: ["operator.approvals"],
    },
  );

  expect(await handlePluginCommand(buildPluginParams("/approve-deploy"), true)).toEqual({
    shouldContinue: false,
    reply: { text: "⚠️ This command requires gateway scope: operator.approvals." },
  });
  expect(handler).not.toHaveBeenCalled();

  const allowedParams = buildPluginParams("/approve-deploy");
  allowedParams.ctx.GatewayClientScopes = ["operator.approvals"];

  expect(await handlePluginCommand(allowedParams, true)).toEqual({
    shouldContinue: true,
    reply: { text: "approved" },
  });
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([
  ["Gateway command routed to its originating channel", "webchat", "whatsapp"],
  ["provider taking precedence over a different surface", "whatsapp", undefined],
])("keeps binding selection and execution aligned for %s", async (_name, provider, origin) => {
  const handler = registerTestCommand();
  const cfg = channelConfig;
  const commandBody = "/card";
  const ctx = finalizeInboundContext({
    Provider: provider,
    Surface: "webchat",
    OriginatingChannel: origin,
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    SenderId: "test-user",
    From: "test-user",
    To: "test-bot",
  });
  const replyOptions: NonNullable<HandleCommandsParams["opts"]> &
    PluginCommandExecutionReplyOptions = {};

  expect(shouldBypassPluginOwnedBindingForCommand(ctx, cfg, replyOptions)).toBe(true);
  expect(replyOptions[PLUGIN_COMMAND_DISPATCH]?.kind).toBe("plugin");
  const params = buildPluginParams(commandBody, cfg);
  params.ctx = ctx;
  params.opts = replyOptions;
  params.command = buildCommandContext({
    ctx,
    cfg,
    sessionKey: params.sessionKey,
    isGroup: false,
    triggerBodyNormalized: commandBody,
    commandAuthorized: true,
  });

  await expect(handlePluginCommand(params, true)).resolves.toEqual({
    shouldContinue: false,
    reply: { text: "from plugin" },
  });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(firstCommandContext(handler)).toMatchObject({
    channel: "whatsapp",
    commandBody,
    sessionKey: params.sessionKey,
  });
});

it("carries one binding selection into dispatch without rematching a replacement registry", async () => {
  const originalHandler = registerTestCommand();
  const cfg = commandConfig;
  const replyOptions = selectPluginCommand("/card", cfg);

  const replacement = createEmptyPluginRegistry();
  const replacementHandler = vi.fn(async () => ({ text: "replacement" }));
  expect(
    registerPluginCommandInRegistry(replacement, "replacement", {
      name: "card",
      description: "Replacement card",
      handler: replacementHandler,
    }),
  ).toEqual({ ok: true });
  setActivePluginRegistry(replacement);
  const params = buildPluginParams("/card", cfg);
  params.opts = replyOptions;

  const result = await handlePluginCommand(params, true);

  expect(result?.reply?.text).toContain("registry changed");
  expect(originalHandler).not.toHaveBeenCalled();
  expect(replacementHandler).not.toHaveBeenCalled();
});

it("treats an explicit non-plugin catalog winner as terminal for plugin matching", async () => {
  const handler = registerTestCommand();
  const params = buildPluginParams("/card", commandConfig);
  params.opts = {
    [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
  } as NonNullable<HandleCommandsParams["opts"]> & PluginCommandExecutionReplyOptions;

  await expect(handlePluginCommand(params, true)).resolves.toBeNull();
  expect(handler).not.toHaveBeenCalled();
});
