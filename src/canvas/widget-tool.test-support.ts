import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as gateway from "../agents/tools/in-process-gateway.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { closeBoardDatabases } from "../boards/board-store.test-support.js";
import type { createBoardHarness } from "../gateway/server-methods/board.test-support.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";

export type WidgetToolOptions = NonNullable<Parameters<typeof createShowWidgetTool>[0]>;
export const asGatewayCaller =
  (invoke: ReturnType<typeof createBoardHarness>["invoke"]): InProcessGatewayCaller =>
  async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const [ok, value, error] = (await invoke(method, params)).mock.calls[0]!;
    if (!ok) {
      throw new Error(error?.message ?? "board request failed");
    }
    return value as T;
  };
type WidgetTool = ReturnType<typeof createShowWidgetTool>;
export const widget = { title: "Status", widget_code: "<p>ready</p>" };
export const runWidget = (tool: WidgetTool, args: Record<string, unknown> = {}) =>
  tool.execute("widget-call", { ...widget, ...args });
export function widgetPayload(result: Awaited<ReturnType<WidgetTool["execute"]>>) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("expected widget tool text result");
  }
  return JSON.parse(text);
}

type ChannelPresenter = Extract<WidgetPresenter, { target: "current_channel" }>;
export const currentPresenter = (
  present: ChannelPresenter["present"],
  options: Partial<Omit<ChannelPresenter, "target" | "present">> = {},
): ChannelPresenter => ({
  target: "current_channel",
  description: "Test channel",
  capabilities: { sourceKinds: ["html"] },
  match: () => true,
  availability: async () => ({ ok: true, value: { available: true } }),
  present,
  ...options,
});

export function useWidgetHarness() {
  let stateDir: string;
  beforeEach(async () => {
    resetPluginRuntimeStateForTest();
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-widget-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await closeBoardDatabases();
    resetPluginRuntimeStateForTest();
    await rm(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const documentDir = (id: string) => path.join(resolveCanvasDocumentsDir(stateDir), id);
  return {
    get stateDir() {
      return stateDir;
    },
    createTool: createShowWidgetTool,
    documentDir,
    documentFile: (id: string, file = "index.html") => path.join(documentDir(id), file),
    expectNoDocument: () => expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow(),
  };
}

export function createBoardPutCaller(
  grantState: "none" | "pending" | "rejected" | "granted" = "none",
) {
  const mock = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
    widgets: [{ name: params.name, tabId: "main", grantState }],
    resolvedWidgetName: params.name,
  }));
  const callGateway: InProcessGatewayCaller = async <T>(...args: Parameters<typeof mock>) =>
    (await mock(...args)) as T;
  vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(callGateway);
  return { mock };
}
