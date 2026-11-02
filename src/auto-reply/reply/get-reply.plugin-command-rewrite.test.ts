import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { waitForPluginCacheRetirement } from "../../plugins/plugin-cache.js";
import {
  createPluginCommandRuntime,
  matchPluginCommandInvocation,
  PLUGIN_COMMAND_DISPATCH,
} from "../../plugins/plugin-command-runtime.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async () => ({
    payloads: [{ text: "Agent answered" }],
    meta: { durationMs: 1 },
  })),
}));

const PLUGIN_ID = "prompt-commands";
// A /learn-shaped command: a subcommand replies directly; the bare form becomes the agent prompt.
const PLUGIN_SOURCE = `module.exports = { id: "${PLUGIN_ID}", register(api) {
  api.registerCommand({
    name: "recall",
    description: "Recall what we did",
    acceptsArgs: true,
    handler: (ctx) => {
      globalThis.openclawRecallRuns = (globalThis.openclawRecallRuns ?? 0) + 1;
      const args = (ctx.args ?? "").trim();
      if (args === "list") return { text: "Nothing saved yet." };
      return { continueAgent: { prompt: "Recall request (JSON string): " + JSON.stringify(args || "everything") } };
    },
  });
  api.registerCommand({
    name: "broken",
    description: "Returns an invalid continuation",
    handler: () => ({ continueAgent: { prompt: "  " } }),
  });
} };`;

declare global {
  var openclawRecallRuns: number | undefined;
}

let state: OpenClawTestState | undefined;
let registry: PluginRegistry | undefined;

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  if (registry) {
    await expect(disposePluginRegistryInstances(registry)).resolves.toMatchObject({ failures: [] });
    await expect(waitForPluginCacheRetirement()).resolves.toMatchObject({ failures: [] });
    registry = undefined;
  }
  await state?.cleanup();
  state = undefined;
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
  globalThis.openclawRecallRuns = undefined;
});

async function loadPromptCommandPlugin(): Promise<OpenClawConfig> {
  const fixture = await createOpenClawTestState({
    label: "plugin-command-rewrite",
    env: { OPENCLAW_TEST_FAST: "0", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  state = fixture;
  const pluginDir = path.join(fixture.root, "plugin");
  const pluginFile = path.join(pluginDir, "index.cjs");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(pluginFile, PLUGIN_SOURCE);
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        workspace: fixture.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [pluginFile] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    },
    commands: { text: true },
  });
  await fixture.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  registry = loadOpenClawPlugins({
    config: cfg,
    workspaceDir: fixture.workspaceDir,
    cache: false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  expect(registry.plugins.find((plugin) => plugin.id === PLUGIN_ID)?.status).toBe("loaded");
  return cfg;
}

async function send(
  cfg: OpenClawConfig,
  body: string,
  sessionKey: string,
  opts?: Parameters<typeof getReplyFromConfig>[1],
) {
  return [
    await getReplyFromConfig(
      finalizeInboundContext({
        Body: body,
        RawBody: body,
        BodyForAgent: body,
        CommandBody: body,
        CommandSource: "text",
        CommandAuthorized: true,
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: sessionKey,
      }),
      opts,
      cfg,
    ),
  ].flat();
}

it("continues a plugin slash command as an agent turn with its replacement prompt", async () => {
  const cfg = await loadPromptCommandPlugin();

  const reply = await send(cfg, "/recall the deploy steps", "agent:main:plugin-rewrite");

  expect(reply).toEqual([expect.objectContaining({ text: "Agent answered" })]);
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
  const prompt = 'Recall request (JSON string): "the deploy steps"';
  expect(input.prompt).toContain(prompt);
  expect(input.prompt).not.toContain("/recall");
  // Core rewrites (/learn, /dashboard, /loop) record the rewritten text as the user turn.
  expect(input.transcriptPrompt).toBe(prompt);
});

it("applies a continuation a native channel already ran without running the command again", async () => {
  const cfg = await loadPromptCommandPlugin();
  const body = "/recall the deploy steps";
  const dispatch = matchPluginCommandInvocation(createPluginCommandRuntime(), body, {
    channel: "webchat",
  })?.dispatch;
  expect(dispatch).toBeDefined();
  // Telegram and Discord run native commands themselves, then hand the same dispatch over.
  await dispatch!.execute({
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: body,
    config: cfg,
  });

  const reply = await send(cfg, body, "agent:main:native-handoff", {
    [PLUGIN_COMMAND_DISPATCH]: dispatch,
  } as Parameters<typeof getReplyFromConfig>[1]);

  expect(reply).toEqual([expect.objectContaining({ text: "Agent answered" })]);
  expect(globalThis.openclawRecallRuns).toBe(1);
  const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
  expect(input.transcriptPrompt).toBe('Recall request (JSON string): "the deploy steps"');
});

it("matches the transcript shape of a core command rewrite", async () => {
  const cfg = await loadPromptCommandPlugin();

  await send(cfg, "/dashboard release health", "agent:main:core-rewrite");

  const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
  expect(input.transcriptPrompt).toContain("release health");
  expect(input.transcriptPrompt).not.toContain("/dashboard");
});

it("replies directly without an agent turn when the command does not continue", async () => {
  const cfg = await loadPromptCommandPlugin();

  const reply = await send(cfg, "/recall list", "agent:main:plugin-direct");

  expect(reply).toEqual([expect.objectContaining({ text: "Nothing saved yet." })]);
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
});

it("refuses an empty replacement prompt instead of running the agent", async () => {
  const cfg = await loadPromptCommandPlugin();

  const reply = await send(cfg, "/broken", "agent:main:plugin-broken");

  expect(reply).toEqual([
    expect.objectContaining({ text: "⚠️ Command failed. Please try again later." }),
  ]);
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
});
