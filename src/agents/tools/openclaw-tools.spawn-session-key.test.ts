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
    spawnToolOptions: captureTool("sessions_spawn"),
    sendToolOptions: captureTool("sessions_send"),
    subagentsToolOptions: captureTool("subagents"),
  };
});

// mock-isolation: Keep plugin discovery outside the tool-factory lineage contract.
vi.mock("../openclaw-plugin-tools.js", () => ({ resolveOpenClawPluginToolsForOptions: () => [] }));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./sessions-send-tool.js", () => ({ createSessionsSendTool: mocks.sendToolOptions }));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./sessions-spawn-tool.js", () => ({ createSessionsSpawnTool: mocks.spawnToolOptions }));

// mock-isolation: Capture tool-constructor ownership without initializing unrelated tool runtimes.
vi.mock("./subagents-tool.js", () => ({ createSubagentsTool: mocks.subagentsToolOptions }));

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
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

it("uses durable lineage keys for session controls", () => {
  createTools(durableKey);
  expect(mocks.spawnToolOptions).toHaveBeenCalledWith(
    expect.objectContaining({ agentSessionKey: durableKey, completionOwnerKey: durableKey }),
  );
  expectKey(mocks.sendToolOptions, durableKey);
  expectKey(mocks.subagentsToolOptions, durableKey);
});

it("falls back to agentSessionKey when runSessionKey is absent", () => {
  createTools();
  expectKey(mocks.spawnToolOptions, policyKey);
  expectKey(mocks.subagentsToolOptions, policyKey);
});
