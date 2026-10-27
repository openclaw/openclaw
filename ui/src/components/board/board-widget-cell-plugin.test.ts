import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { createBoardWidget } from "../../lib/board/widget.test-support.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createSessionOwnerMenuHarness } from "../../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { callbacks, cleanupCells, mountCell } from "./board-widget-cell.test-support.ts";
import "./board-widget-cell.solid.tsx";

const reportLoad = vi.hoisted(() => ({
  promise: Promise.resolve(),
  requested: vi.fn(),
  fail: false,
}));
vi.mock("../../lib/board/widgets/report.tsx", async (importOriginal) => {
  reportLoad.requested();
  await reportLoad.promise;
  const actual = await importOriginal<typeof import("../../lib/board/widgets/report.tsx")>();
  return {
    ...actual,
    ReportWidget: (props: Parameters<typeof actual.ReportWidget>[0]) => {
      if (reportLoad.fail) {
        throw new Error("Report temporarily unavailable");
      }
      return actual.ReportWidget(props);
    },
  };
});

const resourceAcquisitions = vi.hoisted(() => ({ frame: vi.fn(), mcp: vi.fn() }));
vi.mock("./board-widget-frame.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./board-widget-frame.tsx")>();
  return {
    ...actual,
    createBoardWidgetFrame: (...args: Parameters<typeof actual.createBoardWidgetFrame>) => {
      resourceAcquisitions.frame();
      return actual.createBoardWidgetFrame(...args);
    },
  };
});
vi.mock("./board-mcp-app-lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./board-mcp-app-lifecycle.ts")>();
  return {
    ...actual,
    createBoardMcpAppLifecycle: (...args: Parameters<typeof actual.createBoardMcpAppLifecycle>) => {
      resourceAcquisitions.mcp();
      return actual.createBoardMcpAppLifecycle(...args);
    },
  };
});

afterEach(cleanupCells);

// The session progress element arrives via a lazy chunk; a cold transform can
// exceed vi.waitFor's 1s default on loaded machines, so these waits get a
// real budget instead of flaking.
const CHUNK_LOAD_WAIT = { timeout: 10_000 };
type Cell = ReturnType<typeof mountCell>;
const progressError = (cell: Cell) => cell.querySelector('[data-test-id="session-progress-error"]');
const progressCard = (cell: Cell) => cell.querySelector('[data-progress-card-placement="board"]');
const retryProgress = (cell: Cell) => progressError(cell)?.querySelector("button")?.click();
const accessDenied = "Select a session you can access or change sharing for this session.";
const progressTag = "openclaw-session-progress-widget";
const reportTag = "openclaw-report-widget";
async function waitForText(cell: Cell, selector: string, text: string) {
  await vi.waitFor(
    () => expect(cell.querySelector(selector)?.textContent).toContain(text),
    CHUNK_LOAD_WAIT,
  );
}

function progressContext(
  request: object,
  overrides: { gateway?: object; methods?: string[] } = {},
): ApplicationContext {
  const context = {
    agentSelection: { state: { scopeId: null }, subscribe: () => () => undefined },
    gateway: {
      snapshot: {
        phase: "connected",
        client: { request },
        hello: {
          features: { methods: overrides.methods ?? ["progressCard.get"] },
          controlUiWidgetKinds: [
            { pluginId: "session", kind: "session:progress", label: "Session progress" },
          ],
        },
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
      ...overrides.gateway,
    },
  } as unknown as ApplicationContext;
  const sessions = createTestSessionCapability(context.gateway);
  onTestFinished(() => sessions.dispose());
  return { ...context, sessions };
}

function progressWidget(name: string, props?: BoardWidget["props"], position = 0): BoardWidget {
  return createBoardWidget({
    name,
    title: "Session progress",
    contentKind: "plugin",
    pluginKind: "session:progress",
    ...(props ? { props } : {}),
    position,
  });
}

function progressResponse(
  sessionKey: string,
  step = "Owned work",
  updatedAt = 1,
  includeMarkdown = true,
) {
  return {
    card: {
      sessionKey,
      revision: 1,
      updatedAt,
      ...(includeMarkdown ? { markdown: `Progress for ${sessionKey}` } : {}),
      steps: [{ step, status: "in_progress" }],
    },
  };
}

describe("plugin board widget cells", () => {
  it("refreshes a ticket added to a native widget in place on a board revision", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    resourceAcquisitions.frame.mockClear();
    resourceAcquisitions.mcp.mockClear();
    const native = createBoardWidget({
      contentKind: "plugin",
      pluginKind: "fixture:native",
    });
    const refreshFrame = vi.fn(async () => undefined);
    const cell = mountCell(native, {
      boardRevision: 1,
      callbacks: callbacks({ frameLoadFailed: refreshFrame }),
    });
    await cell.updateComplete;
    expect(resourceAcquisitions.frame).not.toHaveBeenCalled();
    expect(resourceAcquisitions.mcp).not.toHaveBeenCalled();

    native.viewTicket = "native-ticket";
    native.viewTicketTtlMs = 16_000;
    cell.boardRevision = 2;
    await cell.updateComplete;
    expect(resourceAcquisitions.frame).toHaveBeenCalledOnce();
    expect(resourceAcquisitions.mcp).toHaveBeenCalledOnce();

    native.title = "Updated native widget";
    cell.boardRevision = 3;
    await cell.updateComplete;
    expect(resourceAcquisitions.frame).toHaveBeenCalledOnce();
    expect(resourceAcquisitions.mcp).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(refreshFrame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshFrame).toHaveBeenCalledExactlyOnceWith(native.name);
  });

  it("acquires the external owner pair only once after a native cell needs a frame", async () => {
    resourceAcquisitions.frame.mockClear();
    resourceAcquisitions.mcp.mockClear();
    const native = createBoardWidget({
      contentKind: "plugin",
      pluginKind: "fixture:native",
    });
    const cell = mountCell(native, {
      active: false,
      widgetFrameUrl: () => "/synthetic-frame",
    });
    await cell.updateComplete;
    expect(resourceAcquisitions.frame).not.toHaveBeenCalled();
    expect(resourceAcquisitions.mcp).not.toHaveBeenCalled();

    cell.widget = { ...native, contentKind: "html", revision: 2 };
    await cell.updateComplete;
    await waitForSolid(() => expect(cell.querySelector("iframe")).not.toBeNull());
    expect(resourceAcquisitions.frame).toHaveBeenCalledOnce();
    expect(resourceAcquisitions.mcp).toHaveBeenCalledOnce();
    const frame = cell.querySelector("iframe");

    cell.active = true;
    await cell.updateComplete;
    cell.active = false;
    await cell.updateComplete;
    expect(cell.querySelector("iframe")).toBe(frame);
    cell.widget = { ...native, revision: 3 };
    await cell.updateComplete;
    expect(cell.querySelector("iframe")).toBeNull();
    cell.widget = { ...native, contentKind: "html", revision: 4 };
    await cell.updateComplete;
    await waitForSolid(() => expect(cell.querySelector("iframe")).not.toBeNull());
    expect(resourceAcquisitions.frame).toHaveBeenCalledOnce();
    expect(resourceAcquisitions.mcp).toHaveBeenCalledOnce();
  });

  it("shares rendering subscriptions across native and inactive frame cells with independent lifetimes", async () => {
    function application() {
      const { context, publish } = createSessionOwnerMenuHarness();
      publish({
        hello: {
          ...context.gateway.snapshot.hello!,
          controlUiWidgetKinds: [
            { pluginId: "session", kind: "session:progress", label: "Session progress" },
          ],
        },
      });
      const gatewayListeners = new Set<Parameters<ApplicationGateway["subscribe"]>[0]>();
      const subscribe = context.gateway.subscribe.bind(context.gateway);
      const gatewaySubscriptions = vi
        .spyOn(context.gateway, "subscribe")
        .mockImplementation((listener) => {
          gatewayListeners.add(listener);
          const stop = subscribe(listener);
          return () => {
            gatewayListeners.delete(listener);
            stop();
          };
        });
      onTestFinished(() => gatewaySubscriptions.mockRestore());
      const pluginListeners = new Set<() => void>();
      const plugins = {
        ...context.plugins,
        isLoading: () => false,
        subscribe: vi.fn((listener: () => void) => {
          pluginListeners.add(listener);
          return () => pluginListeners.delete(listener);
        }),
      };
      return {
        context: { ...context, plugins },
        gatewayListeners,
        pluginListeners,
        acquisitions: () => [
          gatewaySubscriptions.mock.calls.length,
          plugins.subscribe.mock.calls.length,
        ],
      };
    }
    const first = application();
    const second = application();
    const cells = Array.from({ length: 12 }, (_, index) => {
      const native = index % 2 === 0;
      const widget: BoardWidget = {
        name: `widget-${index}`,
        tabId: "main",
        contentKind: native ? "plugin" : "html",
        ...(native ? { pluginKind: "session:progress" } : {}),
        sizeW: 6,
        sizeH: 4,
        position: index,
        grantState: "none",
        revision: 1,
      };
      return mountCell(widget, {
        context: index < 8 ? first.context : second.context,
        active: false,
        widgetFrameUrl: () => "/synthetic-frame",
      });
    });
    await Promise.all(cells.map((cell) => cell.updateComplete));
    await waitForSolid(() => {
      expect(first.acquisitions()).toEqual([1, 1]);
      expect(second.acquisitions()).toEqual([1, 1]);
    });
    expect(cells[1]!.querySelector("iframe")).not.toBeNull();
    cells[0]!.remove();
    await waitForSolid(() => expect(first.gatewayListeners.size).toBe(1));
    for (const cell of cells.slice(1, 8)) {
      cell.remove();
    }
    await waitForSolid(() => {
      expect(first.gatewayListeners.size).toBe(0);
      expect(first.pluginListeners.size).toBe(0);
      expect(second.gatewayListeners.size).toBe(1);
      expect(second.pluginListeners.size).toBe(1);
    });
    for (const cell of cells.slice(8)) {
      cell.remove();
    }
    await waitForSolid(() => {
      expect(second.gatewayListeners.size).toBe(0);
      expect(second.pluginListeners.size).toBe(0);
    });
  });

  it("updates a healthy frame when only its URL resolver changes", async () => {
    const widget: BoardWidget = createBoardWidget({
      name: "external-report",
      contentKind: "plugin",
      pluginKind: "reports:external",
      frameUrl: "https://reports.example.test/report",
    });
    const cell = mountCell(widget, {
      widgetFrameUrl: () => "/report/initial",
    });
    await cell.updateComplete;
    const frame = cell.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/report/initial");

    cell.widgetFrameUrl = () => "/report/refreshed";
    await cell.updateComplete;
    await waitForSolid(() => expect(frame.getAttribute("src")).toBe("/report/refreshed"));
    expect(cell.querySelector("iframe")).toBe(frame);
    expect(cell.widget).toBe(widget);
  });

  it.each([false, true])(
    "preserves a removable unavailable widget (Labs disabled: %s)",
    async (labsDisabled) => {
      const widget: BoardWidget = createBoardWidget({
        name: "work-item",
        title: "Work item",
        contentKind: "plugin",
        pluginKind: "custom-review:card",
        props: { cardId: "card-123" },
      });
      const cellCallbacks = callbacks();
      const navigate = vi.fn();
      const context = {
        basePath: "/console",
        navigate,
        gateway: { snapshot: { phase: "connected" }, subscribe: () => () => undefined },
        plugins: {
          errors: labsDisabled
            ? [
                {
                  pluginId: "custom-review",
                  code: "custom-plugin-ui-disabled",
                  message: "Disabled",
                },
              ]
            : [],
          registrations: () => [],
          isLoading: () => false,
          subscribe: () => () => undefined,
        },
      } as unknown as ApplicationContext;
      const cell = mountCell(widget, {
        context,
        sessionKey: "agent:main:test",
        callbacks: cellCallbacks,
      });
      await cell.updateComplete;

      const placeholder = cell.querySelector('[data-test-id="board-disabled-plugin"]');
      expect(placeholder?.textContent).toContain(
        labsDisabled ? "Custom plugin UI is off" : "Widget from disabled plugin custom-review",
      );
      expect(cell.widget).toBe(widget);
      expect(cellCallbacks.remove).not.toHaveBeenCalled();
      const labsLink = placeholder?.querySelector<HTMLAnchorElement>(
        'a[href="/console/settings/labs"]',
      );
      if (labsDisabled) {
        expect(labsLink?.textContent?.trim()).toBe("Open Labs");
        labsLink?.click();
        expect(navigate).toHaveBeenCalledExactlyOnceWith("labs");
        expect(cellCallbacks.remove).not.toHaveBeenCalled();
      } else {
        expect(labsLink).toBeNull();
      }
      const removeButton = placeholder?.querySelector("button");
      expect(removeButton).not.toBeNull();
      removeButton?.click();
      await vi.waitFor(() => expect(cellCallbacks.remove).toHaveBeenCalledWith(widget));
    },
  );

  it("loads and retries an active report independently, retaining it while hidden", async () => {
    const loadGate = Promise.withResolvers<void>();
    reportLoad.promise = loadGate.promise;
    reportLoad.fail = true;
    onTestFinished(() => {
      reportLoad.fail = false;
      loadGate.resolve();
    });
    const request = vi.fn();
    const registrations = vi.fn(() => []);
    const context = {
      gateway: {
        subscribe: () => () => undefined,
        snapshot: {
          phase: "connected",
          client: { request },
          hello: {
            controlUiWidgetKinds: [
              { pluginId: "session", kind: "session:report", label: "Report" },
            ],
          },
        },
      },
      plugins: { registrations, isLoading: () => false, errors: [], subscribe: () => () => {} },
    } as unknown as ApplicationContext;
    const widget: BoardWidget = createBoardWidget({
      name: "summary",
      contentKind: "plugin",
      pluginKind: "session:report",
      props: { blocks: [{ type: "text", text: "Saved report content" }] },
    });
    const cell = mountCell(widget, {
      context,
      sessionKey: "agent:main:dashboard",
      active: false,
    });
    await cell.updateComplete;
    expect(reportLoad.requested).not.toHaveBeenCalled();
    cell.active = true;
    await waitForSolid(() => {
      expect(reportLoad.requested).toHaveBeenCalledOnce();
      expect(cell.querySelector(".board-widget__plugin-loading")).not.toBeNull();
    });
    expect(cell.querySelector(reportTag)).toBeNull();
    loadGate.resolve();
    await waitForText(cell, ".lazy-view-error", "Report temporarily unavailable");
    reportLoad.fail = false;
    cell.active = false;
    await cell.updateComplete;
    cell.active = true;
    await cell.updateComplete;
    expect(cell.querySelector(".lazy-view-error")).not.toBeNull();
    cell.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
    await waitForText(cell, reportTag, "Saved report content");
    expect(cell.querySelector("iframe")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(registrations).not.toHaveBeenCalled();
    const report = cell.querySelector(reportTag);
    cell.active = false;
    await cell.updateComplete;
    await waitForSolid(() => expect(cell.querySelector(reportTag)).toBe(report));
    cell.active = true;
    cell.widget = {
      ...cell.widget!,
      props: { blocks: [{ type: "text", text: "Updated saved report" }] },
    };
    await waitForSolid(() => {
      expect(cell.querySelector(reportTag)).toBe(report);
      expect(report?.textContent).toContain("Updated saved report");
      expect(reportLoad.requested).toHaveBeenCalledOnce();
    });
  });

  it("renders an advertised session progress card and its empty state", async () => {
    const dashboard = "agent:main:dashboard";
    const target = "agent:main:target";
    const researchGlobal = "agent:research:global";
    const mainGlobal = "agent:main:global";
    const scenarios = [
      [dashboard, target, target],
      [dashboard, undefined, dashboard],
      [researchGlobal, undefined, researchGlobal],
      [researchGlobal, "global", researchGlobal],
      [mainGlobal, "global", mainGlobal],
      [researchGlobal, "agent:other:global", "agent:other:global"],
      ["agent:research:main", "global", researchGlobal],
      ["agent:research:dashboard", "notes", "agent:research:notes"],
      [dashboard, "notes", "agent:main:notes"],
    ] as const;

    for (const [index, [dashboardSessionKey, override, resolvedKey]] of scenarios.entries()) {
      const requestedSessionKey =
        index > 1 && (!override || override === "global") ? "global" : resolvedKey;
      const requestedAgentId = resolvedKey.split(":")[1];
      const response =
        index === 1
          ? { card: null }
          : progressResponse(resolvedKey, index === 0 ? "Run focused checks" : "Owned work");
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "sessions.describe") {
          return {
            session:
              result.sessions.find(
                (row) => row.key === params?.key && row.agentId === params?.agentId,
              ) ?? null,
          };
        }
        if (method === "progressCard.get") {
          return response;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      if (index === 0 && response.card) {
        response.card.markdown = "**Release** validation is active.";
      }
      const result = {
        sessions: ["global", "notes"].flatMap((name) =>
          ["main", "research"].map((agentId) => ({
            key: name === "global" ? name : `agent:${agentId}:${name}`,
            agentId,
            sessionId: `${agentId}:${name}`,
            updatedAt: 2,
            status: agentId === "main" ? "failed" : "done",
            startedAt: 0,
            endedAt: 2,
          })),
        ),
      };
      const context = progressContext(request);
      const widget = progressWidget(
        `session-progress-${index}`,
        override ? { sessionKey: override } : undefined,
        index,
      );
      const cell = mountCell(widget, {
        context,
        sessionKey: dashboardSessionKey,
        active: index !== 0,
        scopedSession: true,
      });

      if (index === 0) {
        await cell.updateComplete;
        expect(request).not.toHaveBeenCalled();
        cell.active = true;
      }

      await cell.updateComplete;
      await vi.dynamicImportSettled();
      await vi.waitFor(
        () =>
          expect(request).toHaveBeenCalledWith("progressCard.get", {
            sessionKey: requestedSessionKey,
            ...(requestedSessionKey === "global" ? { agentId: requestedAgentId } : {}),
          }),
        CHUNK_LOAD_WAIT,
      );
      await waitForText(
        cell,
        progressTag,
        index === 1
          ? "No progress card yet"
          : index === 0
            ? "Run focused checks"
            : `Progress for ${resolvedKey}`,
      );
      if (
        (requestedSessionKey === "global" && requestedAgentId === "research") ||
        requestedSessionKey.endsWith(":notes")
      ) {
        expect(cell.querySelector(".session-progress-card__step")?.getAttribute("aria-label")).toBe(
          t("sessionProgressCard.stepLabel", {
            status: t(
              requestedAgentId === "main"
                ? "sessionProgressCard.status.failed"
                : "sessionProgressCard.status.paused",
            ),
            step: "Owned work",
          }),
        );
      }
    }
  });

  it("surfaces a failed session progress read and retries it", async () => {
    const sessionKey = "agent:main:protected";
    const gatewayListeners = new Set<Parameters<ApplicationGateway["subscribe"]>[0]>();
    let attempts = 0;
    let onEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
    const deniedSessionKey = "agent:main:private";
    const request = vi.fn(async (method: string, params: { sessionKey: string }) => {
      if (method === "sessions.describe") {
        return { session: null };
      }
      if (params.sessionKey === deniedSessionKey) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session is private for this connection",
          details: { code: "SESSION_PARTICIPATION_REQUIRED" },
        });
      }
      attempts += 1;
      if (attempts === 1) {
        throw new Error("session not shared");
      }
      return progressResponse(sessionKey, "Recovered progress", 1, false);
    });
    const progressReads = () =>
      request.mock.calls.filter(([method]) => method === "progressCard.get").length;
    const context = progressContext(request, {
      methods: [],
      gateway: {
        subscribe: (listener: Parameters<ApplicationGateway["subscribe"]>[0]) => {
          gatewayListeners.add(listener);
          return () => gatewayListeners.delete(listener);
        },
        subscribeEvents: (listener: NonNullable<typeof onEvent>) => {
          onEvent = listener;
          return () => {
            onEvent = undefined;
          };
        },
      },
    });
    const widget = progressWidget("protected-session-progress", { sessionKey });
    const cell = mountCell(widget, {
      context,
      sessionKey: "agent:main:dashboard",
      scopedSession: true,
    });

    await vi.waitFor(() => expect(progressError(cell)).not.toBeNull(), CHUNK_LOAD_WAIT);
    retryProgress(cell);

    await waitForText(cell, progressTag, "Recovered progress");
    expect(progressReads()).toBe(2);

    const emitChange = () =>
      onEvent?.({
        type: "event",
        event: "progressCard.changed",
        payload: { sessionKey, revision: 2 },
      });
    request.mockRejectedValueOnce(new Error("Refresh temporarily unavailable"));
    emitChange();
    await vi.waitFor(() => expect(progressError(cell)).not.toBeNull());
    expect(progressCard(cell)?.textContent).toContain("Recovered progress");
    expect(progressReads()).toBe(3);
    cell.session = { ...cell.session! };
    for (const listener of gatewayListeners) {
      listener(context.gateway.snapshot);
    }
    await cell.updateComplete;
    await waitForSolid(() => {
      expect(progressError(cell)).not.toBeNull();
      expect(progressReads()).toBe(3);
    });
    retryProgress(cell);
    await vi.waitFor(() => expect(progressError(cell)).toBeNull());
    expect(progressCard(cell)?.textContent).toContain("Recovered progress");
    expect(progressReads()).toBe(4);

    request.mockRejectedValueOnce(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Participation required",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      }),
    );
    emitChange();
    await vi.waitFor(() => expect(progressError(cell)?.textContent).toContain(accessDenied));
    expect(progressCard(cell)).toBeNull();
    expect(progressError(cell)?.querySelector("button")).toBeNull();
    expect(progressReads()).toBe(5);

    cell.widget = { ...widget, props: { sessionKey: deniedSessionKey } };
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("progressCard.get", {
        sessionKey: deniedSessionKey,
      }),
    );
    await vi.waitFor(
      () => expect(progressError(cell)?.textContent).toContain(accessDenied),
      CHUNK_LOAD_WAIT,
    );
    expect(progressError(cell)?.querySelector("button")).toBeNull();
    expect(progressReads()).toBe(6);
  });

  it("keeps a board-less running target live on another session's dashboard", async () => {
    const boardOwnerKey = "agent:main:dashboard";
    const boardlessTargetKey = "agent:main:boardless";
    const now = Date.now();
    const targetRow = {
      key: boardlessTargetKey,
      sessionId: "boardless-session",
      agentId: "main",
      updatedAt: now,
      status: "running",
      hasActiveRun: true,
      startedAt: now - 60_000,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: targetRow };
      }
      if (method === "progressCard.get") {
        return progressResponse(boardlessTargetKey, "Owned work", now);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const context = progressContext(request);
    const widget = progressWidget("cross-session-progress", { sessionKey: boardlessTargetKey });
    const cell = mountCell(widget, {
      context,
      sessionKey: boardOwnerKey,
      active: true,
      scopedSession: true,
    });

    await vi.waitFor(
      () =>
        expect(request).toHaveBeenCalledWith("progressCard.get", {
          sessionKey: boardlessTargetKey,
        }),
      CHUNK_LOAD_WAIT,
    );
    const element = cell.querySelector(progressTag);
    await vi.waitFor(
      () => expect(element?.querySelector(".session-run-spinner")).not.toBeNull(),
      CHUNK_LOAD_WAIT,
    );
    expect(element?.querySelector(".session-progress-card__step--paused")).toBeNull();
    // Liveness must not depend on dashboard gallery membership.
    expect(request).toHaveBeenCalledWith("sessions.describe", {
      key: boardlessTargetKey,
      agentId: "main",
    });
    expect(request.mock.calls.some(([method]) => method === "sessions.list")).toBe(false);
  });
});
