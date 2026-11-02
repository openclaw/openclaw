import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { readBoardHtml } from "../../boards/board-store.test-support.js";
import * as execApprovalsStore from "../../infra/exec-approvals-store.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createBoardHarness as createHarness,
  createMcpAppDependencies,
} from "./board.test-support.js";

const reviewWidgetApproval = vi.hoisted(() => vi.fn());
const readSessionEntry = vi.hoisted(() => vi.fn());
const sessionKey = "agent:main:session";
const approved = { decision: "allow-once", risk: "low", rationale: "synthetic widget" };
const policy = (revision: string) => ({ file: { version: 1 as const }, revision });
const declared = { netOrigins: ["https://api.example.com"], tools: ["health"] };
const weatherWidget = {
  name: "weather",
  content: { kind: "html", html: "<p>weather</p>" },
  declared: { netOrigins: ["https://weather.example"], tools: ["health"] },
};

vi.mock("../../agents/exec-auto-reviewer.js", () => ({
  createModelExecAutoReviewer: vi.fn(() => reviewWidgetApproval),
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntriesFromStoreInWorker: async ({ sessionKeys }: { sessionKeys: string[] }) => ({
    entries: sessionKeys.flatMap((key) => {
      const entry = readSessionEntry();
      return entry ? [{ sessionKey: key, entry }] : [];
    }),
  }),
}));

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  reviewWidgetApproval.mockReset();
  readSessionEntry.mockReset();
  const policyRead = vi
    .spyOn(execApprovalsStore, "readExecApprovalsPolicyReadOnlyAsync")
    .mockResolvedValue(policy("initial-policy"));
  onTestFinished(() => policyRead.mockRestore());
  return () => resetPluginRuntimeStateForTest();
});

it("reuses a reviewed document in a new session but still gates changed bytes and names", async () => {
  let cfg = {
    agents: { entries: { main: {} } },
    tools: { exec: { mode: "auto" as const, reviewer: { timeoutMs: 30_000 } } },
  };
  reviewWidgetApproval.mockResolvedValue(approved);
  const { invoke } = createHarness(undefined, undefined, undefined, {
    getRuntimeConfig: () => cfg,
  });
  const put = (key: string, overrides: Record<string, unknown> = {}) =>
    invoke("board.widget.put", { ...weatherWidget, sessionKey: key, ...overrides });
  for (let index = 0; index < 2; index++) {
    const response = await put(`agent:main:session-${index}`);
    expect(response.mock.calls[0]?.[1]).toMatchObject({
      widgets: [{ name: "weather", grantState: "granted" }],
    });
  }
  expect(reviewWidgetApproval).toHaveBeenCalledTimes(1);
  await put(sessionKey, { content: { kind: "html", html: "<p>changed</p>" } });
  await put(sessionKey, { name: "other" });
  expect(reviewWidgetApproval).toHaveBeenCalledTimes(3);

  cfg = { ...cfg, tools: { exec: { mode: "auto", reviewer: { timeoutMs: 15_000 } } } };
  await put("agent:main:new-config");
  expect(reviewWidgetApproval).toHaveBeenCalledTimes(4);
  vi.mocked(execApprovalsStore.readExecApprovalsPolicyReadOnlyAsync).mockResolvedValue(
    policy("changed-policy"),
  );
  await put("agent:main:new-policy");
  expect(reviewWidgetApproval).toHaveBeenCalledTimes(5);
});

it("refuses a cached assessment when grant authority is revoked during write admission", async () => {
  const cfg = { tools: { exec: { mode: "auto" as const } } };
  let active = true;
  const harness = createHarness(undefined, undefined, undefined, { getRuntimeConfig: () => cfg });
  harness.context.resolveGatewayContext = () => (active ? harness.context : undefined);
  reviewWidgetApproval.mockResolvedValue(approved);
  await harness.invoke("board.widget.put", { ...weatherWidget, sessionKey });
  const grant = harness.store.grant.bind(harness.store);
  const intercepted = vi.spyOn(harness.store, "grant").mockImplementationOnce((...args) => {
    active = false;
    return grant(...args);
  });
  onTestFinished(() => intercepted.mockRestore());
  const target = { sessionKey: "agent:main:revoked", agentId: "main" };
  const response = await harness.invoke("board.widget.put", { ...weatherWidget, ...target });
  expect(response.mock.calls[0]?.[0]).toBe(false);
  expect(reviewWidgetApproval).toHaveBeenCalledTimes(1);
  expect((await harness.store.getSnapshot(target)).widgets[0]?.grantState).toBe("pending");
});

it.each([
  ["read-only", approved, false],
  ["workspace", { ...approved, risk: "medium" }, false],
  ["workspace", { ...approved, decision: "deny" }, false],
  ["workspace", new Error("reviewer unavailable"), false],
  ["workspace", approved, true],
] as const)("routes %s / %j / empty tools=%s", async (mode, review, emptyTools) => {
  const grantState = emptyTools ? "granted" : "rejected";
  readSessionEntry.mockReturnValue({ permissionMode: mode });
  if (review instanceof Error) {
    reviewWidgetApproval.mockRejectedValue(review);
  } else {
    reviewWidgetApproval.mockResolvedValue(review);
  }
  const dependencies = emptyTools ? createMcpAppDependencies() : undefined;
  if (dependencies) {
    vi.mocked(dependencies.resolveAllowedToolNames).mockResolvedValue([]);
  }
  const { invoke, store, mcpApp } = createHarness(undefined, dependencies, undefined, {
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
  });

  const put = await invoke("board.widget.put", {
    sessionKey,
    name: "weather",
    content: emptyTools ? { kind: "mcp-app", viewId: "mcp-app-source" } : weatherWidget.content,
    declared: emptyTools ? undefined : declared,
  });

  expect(put.mock.calls[0]).toMatchObject([true, { widgets: [{ name: "weather", grantState }] }]);
  const stored = emptyTools
    ? await store.readWidgetMcpApp({ sessionKey }, "weather")
    : await readBoardHtml(store, { sessionKey }, "weather");
  expect(stored?.grantState).toBe(grantState);
  if (emptyTools) {
    expect(stored).toMatchObject({ grantState, interactive: true, declaredTools: [] });
  }
  expect(reviewWidgetApproval).toHaveBeenCalledTimes(mode === "workspace" ? 1 : 0);
  if (mode === "workspace") {
    expect(reviewWidgetApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "board-widget",
        name: "weather",
        declared: emptyTools ? {} : declared,
        agent: { id: "main", sessionKey },
      }),
    );
  }

  const response = await invoke("board.get", { sessionKey });
  const [widget] = (response.mock.calls[0]![1] as BoardSnapshot).widgets;
  expect(Boolean(widget?.frameUrl)).toBe(!emptyTools && grantState === "granted");
  if (emptyTools) {
    await invoke("board.widget.appView", {
      sessionKey,
      name: "weather",
      revision: widget?.revision,
      instanceId: widget?.instanceId,
    });
    expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: grantState !== "granted" }),
    );
  }
});
