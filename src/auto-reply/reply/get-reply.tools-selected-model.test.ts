import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createContext as createGatewayTestContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  createReplyRuntimeMocks,
  installReplyRuntimeMocks,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { nativeCommand } from "./get-reply-native-slash-fast-path.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { buildTestCtx } from "./test-ctx.js";

type InventoryInput = Parameters<
  typeof import("../../agents/tools-effective-inventory.js").resolveEffectiveToolInventory
>[0];
const observed = vi.hoisted(() => ({ inputs: [] as InventoryInput[] }));

// Observe the selected inputs while executing the real inventory and its real filters.
vi.mock("../../agents/tools-effective-inventory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/tools-effective-inventory.js")>();
  return {
    ...actual,
    resolveEffectiveToolInventory: (input: InventoryInput) => {
      observed.inputs.push(input);
      return actual.resolveEffectiveToolInventory(input);
    },
  };
});

const runtime = createReplyRuntimeMocks();
installReplyRuntimeMocks(runtime);
let state: OpenClawTestState;
let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

beforeAll(async () => {
  // Native commands use the production registry to distinguish commands from directives.
  vi.doUnmock("../commands-registry.runtime.js");
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
});

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "native-tools-selection",
    env: { OPENCLAW_TEST_FAST: "1" },
  });
  resetReplyRuntimeMocks(runtime);
  runtime.runEmbeddedAgent.mockImplementation(() => {
    throw new Error("Provider generation is forbidden in this command-only proof");
  });
  runtime.loadModelCatalog.mockResolvedValue(
    ["gpt-4.1", "gpt-4.1-mini"].map((id) => ({
      provider: "openai",
      id,
      name: id,
      api: "openai-responses",
      reasoning: false,
      contextWindow: 128_000,
    })),
  );
  observed.inputs.length = 0;
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createSessionConversationTestRegistry());
});

afterEach(async () => {
  try {
    expect(runtime.runEmbeddedAgent).not.toHaveBeenCalled();
  } finally {
    await state.cleanup();
  }
});

type ToolsCase = {
  transport: "text" | "native";
  excluded: boolean;
  channelModel?: string;
  useStoredModel?: boolean;
  body?: string;
  turnModel?: string;
  locked?: boolean;
  authorized?: boolean;
  expectedModel?: string;
  expectedRuntime?: string;
  expectedPublication?: boolean;
  expectedUsage?: boolean;
};

it.each<ToolsCase>([
  {
    transport: "text",
    excluded: true,
    useStoredModel: false,
    locked: true,
    turnModel: "openai/gpt-4.1-mini",
    expectedModel: "gpt-4.1",
    expectedRuntime: "openclaw",
    expectedPublication: true,
  },
  {
    transport: "native",
    excluded: true,
    useStoredModel: false,
    locked: true,
    turnModel: "openai/gpt-4.1-mini",
    expectedModel: "gpt-4.1",
    expectedRuntime: "openclaw",
    expectedPublication: true,
  },
  {
    transport: "text",
    excluded: true,
    channelModel: "gpt-4.1-mini",
    useStoredModel: false,
    expectedPublication: false,
  },
  {
    transport: "native",
    excluded: true,
    channelModel: "gpt-4.1-mini",
    useStoredModel: false,
    expectedPublication: false,
  },
  { transport: "text", excluded: false, expectedPublication: true },
  { transport: "text", excluded: true, expectedPublication: false },
  {
    transport: "native",
    excluded: false,
    channelModel: "gpt-4.1",
    expectedPublication: true,
  },
  { transport: "native", excluded: true, expectedPublication: false },
  { transport: "native", body: "/tools compact", excluded: true, expectedPublication: false },
  { transport: "native", body: "/tools verbose", excluded: true, expectedPublication: false },
  {
    transport: "native",
    excluded: true,
    turnModel: "openai/gpt-4.1",
    channelModel: "gpt-4.1-mini",
    expectedModel: "gpt-4.1",
    expectedRuntime: "openclaw",
    expectedPublication: true,
  },
  {
    transport: "native",
    excluded: true,
    turnModel: "openai/gpt-4.1",
    locked: true,
    channelModel: "gpt-4.1",
    expectedPublication: false,
  },
  { transport: "native", excluded: true, authorized: false },
  { transport: "native", body: "/tools unknown", excluded: true, expectedUsage: true },
])(
  "$transport /tools: exclusion=$excluded body=$body override=$turnModel locked=$locked authorized=$authorized channel=$channelModel stored=$useStoredModel",
  async ({
    transport,
    excluded,
    channelModel,
    useStoredModel = true,
    body = "/tools",
    turnModel,
    locked = false,
    authorized = true,
    expectedModel = "gpt-4.1-mini",
    expectedRuntime = "codex",
    expectedPublication,
    expectedUsage = false,
  }) => {
    const sessionKey = "agent:main:telegram:123";
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    const cfg: OpenClawConfig = markCompleteReplyConfig({
      session: { store: storePath },
      commands: { text: true, allowFrom: { "*": ["123"] } },
      channels: channelModel
        ? { modelByChannel: { telegram: { "123": `openai/${channelModel}` } } }
        : undefined,
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "openai/gpt-4.1" },
          modelPolicy: { allow: ["openai/*"] },
          sandbox: { mode: "off" },
          models: {
            "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } },
            "openai/gpt-4.1-mini": { agentRuntime: { id: "codex" } },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-4.1", "gpt-4.1-mini"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text" as const],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8192,
            })),
          },
        },
      },
      plugins: {
        entries: {
          codex: { config: { codexDynamicToolsExclude: excluded ? ["github_publish"] : [] } },
        },
      },
      tools: { deny: ["gateway", "nodes"] },
    });
    await state.writeConfig(cfg);
    await replaceSessionEntry(
      { storePath, sessionKey, agentId: "main" },
      {
        sessionId: "native-tools-proof",
        updatedAt: Date.now(),
        systemSent: true,
        providerOverride: useStoredModel ? "openai" : undefined,
        modelOverride: useStoredModel ? "gpt-4.1-mini" : undefined,
        modelOverrideSource: useStoredModel ? "user" : undefined,
        modelSelectionLocked: locked,
        sandbox: "required",
        sandboxMode: "off",
      },
    );
    const common = {
      Body: body,
      CommandBody: body,
      RawBody: body,
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      From: authorized ? "telegram:123" : "telegram:denied",
      To: "telegram:456",
      SenderId: authorized ? "123" : "denied",
      CommandAuthorized: authorized,
      ChatType: "direct" as const,
      SessionKey: transport === "native" ? "telegram:slash:123" : sessionKey,
      ...(transport === "native" ? { CommandTargetSessionKey: sessionKey } : {}),
    };
    const ctx = transport === "native" ? nativeCommand(body, common) : buildTestCtx(common);
    const gateway = createGatewayTestContext([], () => cfg);
    const reply = await withPluginRuntimeGatewayContextResolver(
      () => gateway,
      () => getReplyFromConfig(ctx, turnModel ? { modelOverride: turnModel } : undefined, cfg),
    );
    const text = (Array.isArray(reply) ? reply : [reply])
      .map((part) => part?.text ?? "")
      .join("\n");
    if (!authorized || expectedUsage) {
      expect(observed.inputs).toHaveLength(0);
      if (expectedUsage) {
        expect(text).toBe("Usage: /tools [compact|verbose]");
      }
      return;
    }
    expect(text).toContain("Available tools");
    expect(observed.inputs).toHaveLength(1);
    const input = observed.inputs[0];
    if (!input) {
      throw new Error("The real inventory was not reached");
    }
    expect(input.sessionKey).toBe(sessionKey);
    expect(input.sandboxToolPolicy).toBeDefined();
    expect(text).not.toContain("github_identity_status");
    expect(input.modelId).toBe(expectedModel);
    expect(input.agentRuntime).toBe(expectedRuntime);
    expect(text.includes("github_publish")).toBe(expectedPublication);
  },
);
