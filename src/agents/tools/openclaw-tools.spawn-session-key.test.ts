// #137690: durable spawn lineage differs from the account-scoped policy key.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { AnyAgentTool } from "./common.js";

const mocks = vi.hoisted(() => {
  const stubTool = (name: string) =>
    ({
      name,
      label: name,
      displaySummary: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    }) satisfies AnyAgentTool;
  const captureTool = (name: string) => vi.fn((_options: unknown) => stubTool(name));
  return {
    stubTool,
    spawnToolOptions: captureTool("sessions_spawn"),
    sendToolOptions: captureTool("sessions_send"),
    subagentsToolOptions: captureTool("subagents"),
    imageGenerateToolOptions: captureTool("image_generate"),
    videoGenerateToolOptions: captureTool("video_generate"),
    musicGenerateToolOptions: captureTool("music_generate"),
  };
});

// mock-isolation: Keep plugin discovery outside the tool-factory lineage contract.
vi.mock("../openclaw-plugin-tools.js", () => ({ resolveOpenClawPluginToolsForOptions: () => [] }));

vi.mock("../openclaw-tools.media-factory-plan.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // Construct all media tools without replacing the rest of the factory plan.
  return {
    ...actual,
    resolveOptionalMediaToolFactoryPlan: () => ({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: false,
    }),
  };
});

vi.mock("./agents-list-tool.js", () => ({
  createAgentsListTool: () => mocks.stubTool("agents_list"),
}));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./cron-tool.js", () => ({ createCronTool: () => mocks.stubTool("cron") }));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./gateway-tool.js", () => ({ createGatewayTool: () => mocks.stubTool("gateway") }));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./image-generate-tool.js", () => ({
  createImageGenerateTool: mocks.imageGenerateToolOptions,
}));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./image-tool.js", () => ({ createImageTool: () => mocks.stubTool("view_image") }));

vi.mock("./message-tool-execution.js", () => ({
  createMessageTool: () => mocks.stubTool("message"),
}));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./music-generate-tool.js", () => ({
  createMusicGenerateTool: mocks.musicGenerateToolOptions,
}));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./nodes-tool.js", () => ({ createNodesTool: () => mocks.stubTool("nodes") }));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./pdf-tool.js", () => ({ createPdfTool: () => mocks.stubTool("pdf") }));

vi.mock("./session-status-tool.js", () => ({
  createSessionStatusTool: () => mocks.stubTool("session_status"),
}));

vi.mock("./sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => mocks.stubTool("sessions_history"),
}));

vi.mock("./sessions-list-tool.js", () => ({
  createSessionsListTool: () => mocks.stubTool("sessions_list"),
}));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./sessions-send-tool.js", () => ({ createSessionsSendTool: mocks.sendToolOptions }));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./sessions-spawn-tool.js", () => ({ createSessionsSpawnTool: mocks.spawnToolOptions }));

vi.mock("./sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => mocks.stubTool("sessions_yield"),
}));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./subagents-tool.js", () => ({ createSubagentsTool: mocks.subagentsToolOptions }));

vi.mock("./transcripts-tool.js", () => ({
  createTranscriptsTool: () => mocks.stubTool("transcripts"),
}));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./video-generate-tool.js", () => ({
  createVideoGenerateTool: mocks.videoGenerateToolOptions,
}));

vi.mock("./web-tools.js", () => ({
  createWebFetchTool: () => mocks.stubTool("web_fetch"),
  createWebSearchTool: () => mocks.stubTool("web_search"),
}));

import { createOpenClawTools } from "../openclaw-tools.js";

const policyKey = "agent:main:telegram:default:direct:456";
const durableKey = "agent:main:telegram:direct:456";
const createTools = (runSessionKey?: string) =>
  createOpenClawTools({
    agentSessionKey: policyKey,
    runSessionKey,
    disableMessageTool: true,
    disablePluginTools: true,
  });
const expectKey = (captured: typeof mocks.spawnToolOptions, agentSessionKey: string) =>
  expect(captured.mock.calls.map(([options]) => options)).toContainEqual(
    expect.objectContaining({ agentSessionKey }),
  );

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  mocks.spawnToolOptions.mockClear();
  mocks.sendToolOptions.mockClear();
  mocks.subagentsToolOptions.mockClear();
  mocks.imageGenerateToolOptions.mockClear();
  mocks.videoGenerateToolOptions.mockClear();
  mocks.musicGenerateToolOptions.mockClear();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

it("uses durable lineage keys while preserving policy-owned media tasks", () => {
  createTools(durableKey);
  expect(mocks.spawnToolOptions).toHaveBeenCalledWith(
    expect.objectContaining({ agentSessionKey: durableKey, completionOwnerKey: durableKey }),
  );
  expectKey(mocks.sendToolOptions, durableKey);
  expectKey(mocks.subagentsToolOptions, durableKey);
  for (const captured of [
    mocks.imageGenerateToolOptions,
    mocks.videoGenerateToolOptions,
    mocks.musicGenerateToolOptions,
  ]) {
    expectKey(captured, policyKey);
  }
});

it("falls back to agentSessionKey when runSessionKey is absent", () => {
  createTools();
  expectKey(mocks.spawnToolOptions, policyKey);
  expectKey(mocks.subagentsToolOptions, policyKey);
  expectKey(mocks.imageGenerateToolOptions, policyKey);
});
