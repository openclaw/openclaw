import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import type { createBoardHarness } from "../gateway/server-methods/board.test-support.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";

export type WidgetToolOptions = NonNullable<Parameters<typeof createShowWidgetTool>[0]>;
export function asGatewayCaller(
  invoke: ReturnType<typeof createBoardHarness>["invoke"],
): InProcessGatewayCaller {
  return async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const response = await invoke(method, params);
    const [ok, value, error] = response.mock.calls[0]!;
    if (!ok) {
      throw new Error(error?.message ?? "board request failed");
    }
    return value as T;
  };
}
type WidgetTool = ReturnType<typeof createShowWidgetTool>;
export const widget = { title: "Status", widget_code: "<p>ready</p>" };
export function runWidget(tool: WidgetTool, args: Record<string, unknown> = {}) {
  return tool.execute("widget-call", { ...widget, ...args });
}
export function widgetPayload(result: Awaited<ReturnType<WidgetTool["execute"]>>) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("expected widget tool text result");
  }
  return JSON.parse(text);
}

type ChannelPresenter = Extract<WidgetPresenter, { target: "current_channel" }>;
export function currentPresenter(
  present: ChannelPresenter["present"],
  options: Partial<Omit<ChannelPresenter, "target" | "present">> = {},
): ChannelPresenter {
  return {
    target: "current_channel",
    description: "Test channel",
    capabilities: { sourceKinds: ["html"] },
    match: () => true,
    availability: async () => ({ ok: true, value: { available: true } }),
    present,
    ...options,
  };
}

export function useWidgetHarness() {
  let stateDir: string;
  beforeEach(async () => {
    resetPluginRuntimeStateForTest();
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-widget-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetPluginRuntimeStateForTest();
    await rm(stateDir, { recursive: true, force: true });
  });
  const documentDir = (id: string) => path.join(resolveCanvasDocumentsDir(stateDir), id);
  return {
    get stateDir() {
      return stateDir;
    },
    createTool: (options: WidgetToolOptions = {}) => createShowWidgetTool({ stateDir, ...options }),
    documentDir,
    documentFile: (id: string, file = "index.html") => path.join(documentDir(id), file),
    expectNoDocument: () => expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow(),
  };
}

export function createBoardPutCaller(
  grantState: "none" | "pending" | "rejected" | "granted" = "none",
) {
  const mock = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: params.name,
        tabId: "main",
        contentKind: "plugin",
        pluginKind: "diagram:diagram",
        sizeW: 6,
        sizeH: 4,
        position: 0,
        grantState,
        revision: 1,
      },
    ],
    resolvedWidgetName: params.name,
  }));
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => (await mock(method, params)) as T;
  return { mock, callGateway };
}
