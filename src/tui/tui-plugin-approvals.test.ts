import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import {
  captureChoicePromptSelector,
  type TestChoiceSelector as TestSelector,
} from "./components/choice-prompt.test-support.js";
import { createTuiPluginApprovalController } from "./tui-plugin-approvals.js";

function approvalPayload(
  overrides: Record<string, unknown> = {},
  request: Record<string, unknown> = {},
) {
  return {
    id: "plugin:skill-1",
    request: {
      title: "Apply workspace skill proposal",
      description: "Review pending workspace skill changes.",
      pluginId: "workspace-skills",
      severity: "warning",
      toolName: "skill_workshop",
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: "agent:main:main",
      ...request,
    },
    createdAtMs: 1_000,
    expiresAtMs: 6_000,
    ...overrides,
  };
}

const controllers: Array<ReturnType<typeof createTuiPluginApprovalController>> = [];
const pendingCleanup: Array<() => Promise<void>> = [];

function pending<T>(fallback: T) {
  const result = deferred<T>();
  pendingCleanup.push(async () => {
    result.resolve(fallback);
    await Promise.allSettled([result.promise]);
    await new Promise(setImmediate);
  });
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1_000);
});

afterEach(async () => {
  for (const cleanup of pendingCleanup.splice(0)) {
    await cleanup();
  }
  for (const controller of controllers) {
    controller.dispose();
  }
  controllers.length = 0;
  await new Promise(setImmediate);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createHarness() {
  const selectors: TestSelector[] = [];
  const addSystem = vi.fn();
  const closeOverlay = vi.fn();
  const overlayHandles: OverlayHandle[] = [];
  const openOverlay = vi.fn((component: Component) => {
    selectors.push(captureChoicePromptSelector(component));
    const handle = {
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: vi.fn(() => true),
      getBounds: () => undefined,
    } satisfies OverlayHandle;
    overlayHandles.push(handle);
    return handle;
  });
  const requestRender = vi.fn();
  const resolvePluginApproval = vi.fn().mockResolvedValue({ ok: true });
  const listPluginApprovals = vi.fn().mockResolvedValue([]);
  let agentId = "main";
  let sessionKey = "agent:main:main";
  const controller = createTuiPluginApprovalController({
    client: { listPluginApprovals, resolvePluginApproval },
    chatLog: { addSystem },
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    openOverlay,
    closeOverlay,
    requestRender,
  });
  controllers.push(controller);
  return {
    controller,
    request: (request = {}, overrides = {}) =>
      controller.handleEvent("plugin.approval.requested", approvalPayload(overrides, request)),
    render: () =>
      expectDefined(openOverlay.mock.calls[0]?.[0], "prompt test invariant").render(80).join("\n"),
    allow: (index = 0) => {
      selectors[index]?.onSelectionChange?.({ value: "allow-once", label: "Allow once" });
      selectors[index]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    },
    expectAllowed: () =>
      vi.waitFor(() =>
        expect(resolvePluginApproval).toHaveBeenCalledWith("plugin:skill-1", "allow-once"),
      ),
    selectors,
    addSystem,
    closeOverlay,
    openOverlay,
    overlayHandles,
    requestRender,
    resolvePluginApproval,
    listPluginApprovals,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
  };
}

describe("TUI plugin approvals", () => {
  it("ignores malformed plugin approval gateway payloads", () => {
    const harness = createHarness();
    harness.controller.handleEvent("plugin.approval.requested", {
      id: "plugin:missing-request",
    });
    expect(harness.openOverlay).not.toHaveBeenCalled();
  });

  it("shows plugin approvals for the active session and resolves the selection", async () => {
    const harness = createHarness();

    harness.request();

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    const renderedPrompt = stripAnsi(harness.render());
    expect(renderedPrompt).toContain("plugin approval: Apply workspace skill proposal");
    expect(renderedPrompt).toContain("Severity: Warning");
    expect(renderedPrompt).toContain("Tool: skill_workshop");
    expect(renderedPrompt).toContain("Plugin: workspace-skills");
    expect(renderedPrompt).toContain("Review pending workspace skill changes.");
    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual(["allow-once", "deny"]);
    expect(harness.selectors[0]?.setSelectedIndex).toHaveBeenCalledWith(1);

    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    harness.allow();
    await harness.expectAllowed();
    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.addSystem).toHaveBeenLastCalledWith("plugin approval: allowed once");
  });

  it("ignores other sessions and restores matching pending approvals after connect", async () => {
    const harness = createHarness();
    harness.request({ agentId: "other", sessionKey: "agent:other:main" }, { id: "plugin:other" });
    expect(harness.openOverlay).not.toHaveBeenCalled();

    harness.setAgentId("other");
    harness.setSessionKey("agent:other:main");
    harness.controller.sessionChanged();
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);

    harness.controller.handleEvent("plugin.approval.resolved", { id: "plugin:other" });
    harness.setAgentId("main");
    harness.setSessionKey("agent:main:main");
    harness.listPluginApprovals.mockResolvedValueOnce([approvalPayload()]);
    await harness.controller.refresh();

    expect(harness.listPluginApprovals).toHaveBeenCalledTimes(1);
    expect(harness.openOverlay).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["owned alias", "main", "support", true],
    ["normalized alias owner", " MAIN ", "support", true, "Main", "agent:main:support"],
    ["foreign alias owner", "work", "support", false],
    ["ownerless alias", null, "support", false],
    ["missing session", "main", null, false],
    ["contradictory canonical owner", "work", "agent:main:support", false],
    ["canonical parsed owner", null, "agent:main:support", true],
    ["foreign canonical alias collision", "work", "agent:work:support", false],
    ["ownerless foreign key vs bare alias", null, "agent:work:support", false, "main", "support"],
    ["misleading owner on foreign key", "main", "agent:work:support", false, "main", "support"],
    ["ownerless global session", null, "global", false, "main", "global"],
    [
      "case-sensitive opaque reference",
      "main",
      "matrix:group:!room:example.org",
      false,
      "main",
      "agent:main:matrix:group:!Room:example.org",
    ],
  ] as const)(
    "%s",
    (
      _label,
      approvalAgent,
      approvalSession,
      visible,
      selectedAgent = "main",
      selectedSession = "agent:main:support",
    ) => {
      const harness = createHarness();
      harness.setAgentId(selectedAgent);
      harness.setSessionKey(selectedSession);

      harness.request({ agentId: approvalAgent, sessionKey: approvalSession });

      expect(harness.openOverlay).toHaveBeenCalledTimes(visible ? 1 : 0);
    },
  );

  it("preserves requested events received while a refresh is in flight", async () => {
    const harness = createHarness();
    const pendingList = pending<unknown[]>([]);
    harness.listPluginApprovals.mockReturnValueOnce(pendingList.promise);

    const refresh = harness.controller.refresh();
    harness.request();
    pendingList.resolve([]);
    await refresh;

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect resolved approvals from a stale refresh snapshot", async () => {
    const harness = createHarness();
    const pendingList = pending<unknown[]>([]);
    harness.listPluginApprovals.mockReturnValueOnce(pendingList.promise);

    const refresh = harness.controller.refresh();
    harness.controller.handleEvent("plugin.approval.resolved", { id: "plugin:skill-1" });
    pendingList.resolve([approvalPayload()]);
    await refresh;

    expect(harness.openOverlay).not.toHaveBeenCalled();
  });

  it("reruns a refresh requested while another refresh is in flight", async () => {
    const harness = createHarness();
    const pendingList = pending<unknown[]>([]);
    harness.listPluginApprovals.mockReturnValueOnce(pendingList.promise).mockResolvedValueOnce([]);

    const firstRefresh = harness.controller.refresh();
    const secondRefresh = harness.controller.refresh();
    pendingList.resolve([]);
    await Promise.all([firstRefresh, secondRefresh]);

    expect(harness.listPluginApprovals).toHaveBeenCalledTimes(2);
  });

  it("binds global-session approvals to the active agent", () => {
    const harness = createHarness();
    harness.setSessionKey("global");
    harness.request({ agentId: "work", sessionKey: "global" });

    expect(harness.openOverlay).not.toHaveBeenCalled();

    harness.setAgentId("work");
    harness.controller.sessionChanged();

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it.each(["plugin.approval.resolved", "plugin.approval.removed"])(
    "closes an active prompt on %s",
    (event) => {
      const harness = createHarness();
      harness.request();

      harness.controller.handleEvent(event, { id: "plugin:skill-1", decision: "deny" });

      expect(harness.closeOverlay).toHaveBeenCalledExactlyOnceWith(harness.overlayHandles[0]);
    },
  );

  it("dismisses allow-only approvals without authorizing them", () => {
    const harness = createHarness();
    harness.request({ allowedDecisions: ["allow-once"] });

    harness.selectors[0]?.onCancel?.();

    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "plugin approval: dismissed; request remains pending",
    );

    harness.controller.sessionChanged();
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it("requires a visible second confirmation for allow-only approvals", async () => {
    const harness = createHarness();
    harness.request({ allowedDecisions: ["allow-once"] });

    harness.allow();

    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(stripAnsi(harness.render())).toContain("Press Enter again to confirm Allow once.");

    harness.selectors[0]?.onSelect?.({ value: "allow-once", label: "Allow once" });
    await harness.expectAllowed();
  });

  it("reopens a pending approval when resolution fails", async () => {
    const harness = createHarness();
    harness.resolvePluginApproval
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ ok: true });
    harness.request();

    harness.allow();
    await vi.waitFor(() => expect(harness.openOverlay).toHaveBeenCalledTimes(2));
    expect(harness.addSystem).toHaveBeenLastCalledWith(
      "plugin approval failed: gateway unavailable",
    );

    harness.allow(1);
    await vi.waitFor(() => expect(harness.resolvePluginApproval).toHaveBeenCalledTimes(2));
    expect(harness.addSystem).toHaveBeenLastCalledWith("plugin approval: allowed once");
  });

  it("does not reopen an approval while its decision is in flight", async () => {
    const harness = createHarness();
    const pendingResolution = pending({ ok: true });
    harness.resolvePluginApproval.mockReturnValueOnce(pendingResolution.promise);
    harness.request();

    harness.allow();
    await vi.waitFor(() => expect(harness.resolvePluginApproval).toHaveBeenCalledTimes(1));

    harness.listPluginApprovals.mockResolvedValueOnce([approvalPayload()]);
    await harness.controller.refresh();

    expect(harness.openOverlay).toHaveBeenCalledTimes(1);

    pendingResolution.resolve({ ok: true });
    await vi.waitFor(() =>
      expect(harness.addSystem).toHaveBeenLastCalledWith("plugin approval: allowed once"),
    );
  });

  it("removes and refreshes approvals that another client already resolved", async () => {
    const harness = createHarness();
    const staleError = Object.assign(new Error("approval already resolved"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    });
    harness.resolvePluginApproval.mockRejectedValueOnce(staleError);
    harness.request();

    harness.allow();

    await vi.waitFor(() => expect(harness.listPluginApprovals).toHaveBeenCalledTimes(1));
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    expect(harness.addSystem).toHaveBeenLastCalledWith("plugin approval: no longer pending");
  });

  it("flattens and sanitizes untrusted approval text", () => {
    const harness = createHarness();
    harness.request({
      title: "Apply\nAllow once\u202E\u001B]52;c;YWJj\u0007 skill",
      description: "Review\nPress Enter again\u2066\u001B[2J this\u0000 change",
    });

    const renderedPrompt = harness.render();
    for (const control of ["\u001B]52", "\u0007", "\u0000", "\u202E", "\u2066"]) {
      expect(renderedPrompt).not.toContain(control);
    }
    expect(stripAnsi(renderedPrompt)).toContain("plugin approval: Apply Allow once skill");
    expect(stripAnsi(renderedPrompt)).toContain("Request: Review Press Enter again this change");
  });

  it("clears the active prompt timer when disposed", () => {
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const harness = createHarness();
    harness.request();

    expect(vi.getTimerCount()).toBe(1);
    const timer = setTimer.mock.results[0];
    if (timer?.type !== "return") {
      throw new Error("Expected the actual approval timer");
    }
    expect(timer.value.hasRef()).toBe(false);

    harness.controller.dispose();
    harness.controller.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "stale", "failure"])(
    "ignores an in-flight resolution's %s after disposal",
    async (outcome) => {
      const harness = createHarness();
      const resolution = pending({ ok: false });
      harness.resolvePluginApproval.mockReturnValueOnce(resolution.promise);
      harness.request();
      harness.selectors[0]?.onSelect?.({ value: "deny", label: "Deny" });
      expect(harness.resolvePluginApproval).toHaveBeenCalledExactlyOnceWith(
        "plugin:skill-1",
        "deny",
      );
      harness.controller.dispose();
      harness.requestRender.mockClear();

      if (outcome === "failure") {
        resolution.reject(new Error("gateway unavailable"));
      } else {
        resolution.resolve({ ok: outcome === "success" });
      }
      await resolution.promise.catch(() => undefined);

      expect(harness.addSystem).not.toHaveBeenCalled();
      expect(harness.listPluginApprovals).not.toHaveBeenCalled();
      expect(harness.requestRender).not.toHaveBeenCalled();
    },
  );

  it("ignores a stale approval's refresh failure after disposal", async () => {
    const harness = createHarness();
    const pendingList = pending<unknown[]>([]);
    const started = pending<void>(undefined);
    harness.resolvePluginApproval.mockResolvedValueOnce({ ok: false });
    harness.listPluginApprovals.mockImplementationOnce(() => {
      started.resolve();
      return pendingList.promise;
    });
    harness.request();
    harness.selectors[0]?.onSelect?.({ value: "deny", label: "Deny" });
    await started.promise;
    const refresh = harness.controller.refresh();
    harness.controller.dispose();
    harness.addSystem.mockClear();
    harness.requestRender.mockClear();

    pendingList.reject(new Error("refresh unavailable"));
    await refresh.catch(() => undefined);

    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(harness.requestRender).not.toHaveBeenCalled();
  });
});
