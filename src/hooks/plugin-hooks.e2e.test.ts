import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";

const pluginId = "qa-plugin-hook-contracts";
const recordHook = vi.fn<(name: string, event: unknown, context: unknown) => void>();
const sessionContext = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
};

afterEach(() => {
  setEmbeddedPluginApprovalBroker(null);
  setEmbeddedMode(false);
  resetGlobalHookRunner();
  resetPluginLoaderTestStateForTest();
  vi.unstubAllGlobals();
});

afterAll(cleanupPluginLoaderFixturesForTest);

it("routes a loaded before_tool_call policy through the embedded approval boundary", async () => {
  recordHook.mockClear();
  vi.stubGlobal("openclawQaHookRecord", recordHook);
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: pluginId,
    registration: `api.on("before_tool_call", (event, context) => {
      globalThis.openclawQaHookRecord("before_tool_call", event, context);
      if (event.toolName !== "exec") {
        return;
      }
      return {
        params: { ...event.params, policyChecked: true },
        requireApproval: {
          title: "Approve QA exec",
          description: "The fixture plugin requires operator approval.",
          severity: "info",
        },
      };
    });`,
  });
  const registry = loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
      },
    },
    workspaceDir: plugin.dir,
  });
  expect(registry.plugins).toEqual([expect.objectContaining({ id: pluginId, status: "loaded" })]);
  initializeGlobalHookRunner(registry);
  setEmbeddedMode(true);
  const broker = new EmbeddedPluginApprovalBroker();
  setEmbeddedPluginApprovalBroker(broker);

  const event = {
    toolName: "exec",
    params: { command: "pwd" },
    toolCallId: "call-1",
  };
  const resultPromise = runBeforeToolCallHook({ ...event, ctx: sessionContext });

  await vi.waitFor(() => {
    expect(broker.listPending()).toHaveLength(1);
  });
  const pending = expectDefined(broker.listPending()[0], "pending plugin approval request");
  expect(pending.request).toMatchObject({
    pluginId,
    title: "Approve QA exec",
    toolCallId: "call-1",
    toolName: "exec",
  });
  expect(broker.resolve(pending.id, "allow-once")).toBe(true);

  await expect(resultPromise).resolves.toEqual({
    approvalResolution: "allow-once",
    blocked: false,
    params: { command: "pwd", policyChecked: true },
  });
  expect(recordHook.mock.calls).toEqual([
    ["before_tool_call", expect.objectContaining(event), expect.objectContaining(sessionContext)],
  ]);
});
