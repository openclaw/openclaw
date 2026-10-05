import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { readBoardHtml } from "../../boards/board-store.test-support.js";
import * as execApprovalsStore from "../../infra/exec-approvals-store.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  boardWidgetContentPermissionCases,
  createBoardHarness as createHarness,
  createMcpAppDependencies,
} from "./board.test-support.js";

const reviewWidgetApproval = vi.hoisted(() => vi.fn());
const readSessionEntry = vi.hoisted(() => vi.fn());
const sessionKey = "agent:main:session";
const boardBroadcastScope = { sessionKeys: [sessionKey], agentId: "main" };

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

describe("board widget approval", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    reviewWidgetApproval.mockReset();
    readSessionEntry.mockReset();
    const policyRead = vi
      .spyOn(execApprovalsStore, "readExecApprovalsPolicyReadOnlyAsync")
      .mockResolvedValue({ file: { version: 1 }, revision: "initial-policy" });
    onTestFinished(() => policyRead.mockRestore());
    return () => resetPluginRuntimeStateForTest();
  });

  it("reuses a reviewed document in a new session but still gates changed bytes and names", async () => {
    let cfg = {
      agents: { entries: { main: {} } },
      tools: { exec: { mode: "auto" as const, reviewer: { timeoutMs: 30_000 } } },
    };
    reviewWidgetApproval.mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "synthetic widget",
    });
    const { invoke } = createHarness(undefined, undefined, undefined, {
      getRuntimeConfig: () => cfg,
    });
    const widget = {
      name: "weather",
      content: { kind: "html", html: "<p>weather</p>" },
      declared: { netOrigins: ["https://weather.example"], tools: ["health"] },
    };
    for (let index = 0; index < 10; index++) {
      const response = await invoke("board.widget.put", {
        ...widget,
        sessionKey: `agent:main:session-${index}`,
      });
      expect(response.mock.calls[0]?.[1]).toMatchObject({
        widgets: [{ name: "weather", grantState: "granted" }],
      });
    }
    expect(reviewWidgetApproval).toHaveBeenCalledTimes(1);
    await invoke("board.widget.put", {
      ...widget,
      sessionKey,
      content: { kind: "html", html: "<p>changed</p>" },
    });
    await invoke("board.widget.put", { ...widget, sessionKey, name: "other" });
    expect(reviewWidgetApproval).toHaveBeenCalledTimes(3);

    readSessionEntry.mockReturnValue({ permissionMode: "guarded" });
    const guarded = await invoke("board.widget.put", {
      ...widget,
      sessionKey: "agent:main:guarded",
    });
    expect(guarded.mock.calls[0]?.[1]).toMatchObject({
      widgets: [{ grantState: "pending" }],
    });
    expect(reviewWidgetApproval).toHaveBeenCalledTimes(3);

    readSessionEntry.mockReset();
    cfg = { ...cfg, tools: { exec: { mode: "auto", reviewer: { timeoutMs: 15_000 } } } };
    await invoke("board.widget.put", { ...widget, sessionKey: "agent:main:new-config" });
    expect(reviewWidgetApproval).toHaveBeenCalledTimes(4);
    vi.mocked(execApprovalsStore.readExecApprovalsPolicyReadOnlyAsync).mockResolvedValue({
      file: { version: 1 },
      revision: "changed-policy",
    });
    await invoke("board.widget.put", { ...widget, sessionKey: "agent:main:new-policy" });
    expect(reviewWidgetApproval).toHaveBeenCalledTimes(5);
  });

  it("refuses a cached assessment when grant authority is revoked during write admission", async () => {
    const cfg = { tools: { exec: { mode: "auto" as const } } };
    let active = true;
    const harness: ReturnType<typeof createHarness> = createHarness(
      undefined,
      undefined,
      undefined,
      {
        getRuntimeConfig: () => cfg,
        resolveGatewayContext: () => (active ? harness.context : undefined),
      },
    );
    reviewWidgetApproval.mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "synthetic widget",
    });
    const widget = {
      name: "health",
      content: { kind: "html", html: "<p>health</p>" },
      declared: { tools: ["health"] },
    };
    await harness.invoke("board.widget.put", { ...widget, sessionKey });
    const grant = harness.store.grant.bind(harness.store);
    const intercepted = vi.spyOn(harness.store, "grant").mockImplementationOnce((...args) => {
      active = false;
      return grant(...args);
    });
    onTestFinished(() => intercepted.mockRestore());
    const target = { sessionKey: "agent:main:revoked", agentId: "main" };
    const response = await harness.invoke("board.widget.put", { ...widget, ...target });
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(reviewWidgetApproval).toHaveBeenCalledTimes(1);
    expect((await harness.store.getSnapshot(target)).widgets[0]?.grantState).toBe("pending");
  });

  it("reviews a previously rejected document again and skips review for empty declarations", async () => {
    const cfg = { tools: { exec: { mode: "auto" as const } } };
    const { invoke } = createHarness(undefined, undefined, undefined, {
      getRuntimeConfig: () => cfg,
    });
    const widget = { name: "health", content: { kind: "html", html: "<p>health</p>" } };
    for (const declared of [undefined, { tools: [] }]) {
      await invoke("board.widget.put", { ...widget, sessionKey, declared });
    }
    expect(reviewWidgetApproval).not.toHaveBeenCalled();
    for (const decision of ["deny", "ask", "allow-once"] as const) {
      reviewWidgetApproval.mockResolvedValue({ decision, risk: "low", rationale: "synthetic" });
      const response = await invoke("board.widget.put", {
        ...widget,
        sessionKey: `${sessionKey}-${decision}`,
        declared: { tools: ["health"] },
      });
      expect(response.mock.calls[0]?.[1]).toMatchObject({
        widgets: [{ grantState: decision === "allow-once" ? "granted" : "rejected" }],
      });
    }
    expect(reviewWidgetApproval).toHaveBeenCalledTimes(3);
  });

  it.each([
    ...boardWidgetContentPermissionCases
      .filter(
        (row) =>
          row.contentKind === "html" ||
          ("permissionMode" in row &&
            (row.permissionMode !== "workspace" ||
              ("reviewDecision" in row &&
                row.reviewDecision === "allow-once" &&
                !("reviewRisk" in row)))),
      )
      .map((row) => Object.assign({}, row, { emptyTools: false })),
    ...(
      [
        { permissionMode: "full", grantState: "granted" },
        { permissionMode: "workspace", grantState: "granted", reviewDecision: "allow-once" },
        { permissionMode: "guarded", grantState: "pending" },
        { permissionMode: "read-only", grantState: "rejected" },
      ] as const
    ).map((row) => Object.assign({}, row, { contentKind: "mcp-app" as const, emptyTools: true })),
  ])(
    "routes $contentKind through session $permissionMode / effective $mode ($grantState, empty tools=$emptyTools)",
    async (testCase) => {
      const { contentKind, grantState, emptyTools } = testCase;
      const permissionMode = "permissionMode" in testCase ? testCase.permissionMode : undefined;
      const mode = "mode" in testCase ? testCase.mode : undefined;
      const reviewDecision = "reviewDecision" in testCase ? testCase.reviewDecision : undefined;
      const reviewRisk = "reviewRisk" in testCase ? testCase.reviewRisk : undefined;
      const reviewFailure = "reviewFailure" in testCase && testCase.reviewFailure;
      if (permissionMode) {
        readSessionEntry.mockReturnValue({ permissionMode });
      }
      if (reviewDecision) {
        reviewWidgetApproval.mockResolvedValue({
          decision: reviewDecision,
          risk: reviewRisk ?? (reviewDecision === "allow-once" ? "low" : "high"),
          rationale: "widget capability review",
        });
      } else if (reviewFailure) {
        reviewWidgetApproval.mockRejectedValue(new Error("reviewer unavailable"));
      }
      const dependencies = emptyTools ? createMcpAppDependencies() : undefined;
      if (dependencies) {
        vi.mocked(dependencies.resolveAllowedToolNames).mockResolvedValue([]);
      }
      const { invoke, broadcast, store, mcpApp } = createHarness(
        undefined,
        dependencies,
        undefined,
        {
          getRuntimeConfig: () => ({
            agents: { entries: { main: {} } },
            ...(mode ? { tools: { exec: { mode } } } : {}),
          }),
        },
      );

      const put = await invoke("board.widget.put", {
        sessionKey: "agent:main:session",
        name: "weather",
        content:
          contentKind === "html"
            ? { kind: "html", html: "<p>weather</p>" }
            : { kind: "mcp-app", viewId: "mcp-app-source" },
        declared: emptyTools
          ? undefined
          : { netOrigins: ["https://api.example.com"], tools: ["health"] },
      });

      expect(put).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          resolvedWidgetName: "weather",
          widgets: [expect.objectContaining({ name: "weather", grantState })],
        }),
      );
      const stored =
        contentKind === "html"
          ? await readBoardHtml(store, { sessionKey: "agent:main:session" }, "weather")
          : await store.readWidgetMcpApp({ sessionKey: "agent:main:session" }, "weather");
      expect(stored?.grantState).toBe(grantState);
      if (emptyTools) {
        expect(stored).toMatchObject({ grantState, interactive: true, declaredTools: [] });
      }
      const reviewed = permissionMode === "workspace" || mode === "auto";
      expect(reviewWidgetApproval).toHaveBeenCalledTimes(reviewed ? 1 : 0);
      if (reviewed) {
        expect(reviewWidgetApproval).toHaveBeenCalledWith({
          kind: "board-widget",
          name: "weather",
          declared: emptyTools
            ? {}
            : contentKind === "html"
              ? { netOrigins: ["https://api.example.com"], tools: ["health"] }
              : { tools: ["server.refresh", "server.search"] },
          agent: { id: "main", sessionKey: "agent:main:session" },
        });
      }

      const response = await invoke("board.get", { sessionKey: "agent:main:session" });
      const snapshot = response.mock.calls[0]?.[1] as BoardSnapshot | undefined;
      const widget = snapshot?.widgets[0];
      expect(Boolean(widget?.frameUrl)).toBe(contentKind === "html" && grantState === "granted");
      if (contentKind === "mcp-app") {
        await invoke("board.widget.appView", {
          sessionKey: "agent:main:session",
          name: "weather",
          revision: widget?.revision,
          instanceId: widget?.instanceId,
        });
        expect(mcpApp.mintFromTranscript).toHaveBeenLastCalledWith(
          expect.objectContaining({ readOnly: grantState !== "granted" }),
        );
      }
      expect(broadcast).toHaveBeenCalledOnce();
      expect(broadcast).toHaveBeenCalledWith(
        "board.changed",
        { sessionKey, revision: grantState === "pending" ? 1 : 2, widget: "weather" },
        boardBroadcastScope,
      );
    },
  );
});
