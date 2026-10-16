import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { CORE_BOARD_WIDGET_ELEMENTS } from "../../lib/board/widgets/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { boardWidget } from "./board-view.test-support.ts";
import { callbacks, cleanupCells, mountCell } from "./board-widget-cell.test-support.ts";
import "./board-widget-cell.ts";

const progressError = (cell: Element) =>
  cell.querySelector('[data-test-id="session-progress-error"]');
const progress = (cell: Element) => cell.querySelector("openclaw-session-progress-widget");

function pluginWidget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return boardWidget({
    contentKind: "plugin",
    pluginKind: "session:progress",
    title: "Session progress",
    ...overrides,
  });
}

const progressKinds = [
  { pluginId: "session", kind: "session:progress", label: "Session progress" },
];
const noSubscription = () => () => undefined;
const emptySessions = () => ({
  subscribe: noSubscription,
  subscribeList: noSubscription,
  listSnapshot: () => ({ result: null, agentId: null, loading: false, error: null }),
  refreshList: async () => undefined,
});
function progressGateway(request: ReturnType<typeof vi.fn>) {
  return {
    snapshot: {
      phase: "connected",
      client: { request },
      hello: { features: { methods: ["progressCard.get"] }, controlUiWidgetKinds: progressKinds },
    },
    subscribe: noSubscription,
    subscribeEvents: noSubscription,
  };
}
const agentSelection = () => ({ state: { scopeId: null }, subscribe: noSubscription });
const progressResponse = (sessionKey: string, step: string, markdown?: string, updatedAt = 1) => ({
  card: {
    sessionKey,
    revision: 1,
    updatedAt,
    ...(markdown === undefined ? {} : { markdown }),
    steps: [{ step, status: "in_progress" }],
  },
});
const listSnapshot = <T>(result: T) => ({ result, agentId: null, loading: false, error: null });
const finishedSession = (key: string, agentId: string, status: string) => ({
  key,
  agentId,
  status,
  startedAt: 0,
  endedAt: 2,
});
const progressContext = <Sessions extends object, Gateway extends object>(
  request: ReturnType<typeof vi.fn>,
  sessions?: Sessions,
  gateway?: Gateway,
) =>
  ({
    agentSelection: agentSelection(),
    sessions: sessions ?? emptySessions(),
    gateway: gateway ?? progressGateway(request),
  }) as unknown as ApplicationContext;
const waitForProgress = (cell: Element, text: string) =>
  vi.waitFor(() => expect(progress(cell)?.textContent).toContain(text), CHUNK_LOAD_WAIT);
const visibleCard = (cell: Element) => cell.querySelector('[data-progress-card-placement="board"]');
const retryButton = (cell: Element) => progressError(cell)?.querySelector("button") ?? null;
const waitForRequest = (
  request: ReturnType<typeof vi.fn>,
  sessionKey: string,
  agentId?: string,
  options?: { timeout: number },
) =>
  vi.waitFor(
    () =>
      expect(request).toHaveBeenCalledWith("progressCard.get", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      }),
    options,
  );
const accessDenied = (message: string) =>
  new GatewayRequestError({
    code: "INVALID_REQUEST",
    message,
    details: { code: "SESSION_PARTICIPATION_REQUIRED" },
  });

afterEach(cleanupCells);

// Lazy-chunk transforms can exceed the default wait on loaded machines.
const CHUNK_LOAD_WAIT = { timeout: 10_000 };

describe("plugin board widget cells", () => {
  it("updates a healthy frame when only its URL resolver changes", async () => {
    const widget = pluginWidget({
      name: "external-report",
      title: undefined,
      pluginKind: "reports:external",
      frameUrl: "https://reports.example.test/report",
    });
    const cell = mountCell(widget, { widgetFrameUrl: () => "/report/initial" });
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
      const widget = pluginWidget({
        name: "work-item",
        title: "Work item",
        pluginKind: "custom-review:card",
        props: { cardId: "card-123" },
      });
      const cellCallbacks = callbacks();
      const navigate = vi.fn();
      const context = {
        basePath: "/console",
        navigate,
        gateway: { snapshot: { phase: "connected" } },
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
        callbacks: cellCallbacks,
        sessionKey: "agent:main:test",
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

  it("reveals a lazily registered report independently of optional plugin UI", async () => {
    const report = CORE_BOARD_WIDGET_ELEMENTS.find((entry) => entry.kind === "session:report")!;
    const loadModule = report.loadModule;
    const loadGate = Promise.withResolvers<void>();
    const load = vi.spyOn(report, "loadModule").mockImplementation(async () => {
      await loadGate.promise;
      return loadModule();
    });
    onTestFinished(() => {
      loadGate.resolve();
      load.mockRestore();
    });
    const request = vi.fn();
    const registrations = vi.fn(() => []);
    const context = {
      gateway: {
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
    const cell = mountCell(
      pluginWidget({
        name: "summary",
        title: undefined,
        pluginKind: "session:report",
        props: { blocks: [{ type: "text", text: "Saved report content" }] },
      }),
      { context, sessionKey: "agent:main:dashboard" },
    );
    await waitForSolid(() => {
      expect(load).toHaveBeenCalledOnce();
      expect(cell.querySelector(".board-widget__plugin-loading")).not.toBeNull();
    });
    expect(cell.querySelector("openclaw-report-widget")).toBeNull();
    loadGate.resolve();
    await vi.waitFor(
      () =>
        expect(cell.querySelector("openclaw-report-widget")?.textContent).toContain(
          "Saved report content",
        ),
      CHUNK_LOAD_WAIT,
    );
    expect(cell.querySelector("iframe")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(registrations).not.toHaveBeenCalled();
  });

  it("renders an advertised session progress card and its empty state", async () => {
    const dashboardSessionKey = "agent:main:dashboard";
    const targetSessionKey = "agent:main:target";
    const responses = [
      {
        dashboardSessionKey,
        props: { sessionKey: targetSessionKey },
        response: progressResponse(
          targetSessionKey,
          "Run focused checks",
          "**Release** validation is active.",
        ),
        text: "Run focused checks",
        requestedSessionKey: targetSessionKey,
        requestedAgentId: "main",
      },
      {
        dashboardSessionKey,
        props: undefined,
        response: { card: null },
        text: "No progress card yet",
        requestedSessionKey: dashboardSessionKey,
        requestedAgentId: "main",
      },
      ...(
        [
          ["agent:research:global", undefined, "agent:research:global"],
          ["agent:research:global", "global", "agent:research:global"],
          ["agent:main:global", "global", "agent:main:global"],
          ["agent:research:global", "agent:other:global", "agent:other:global"],
          ["agent:research:main", "global", "agent:research:global"],
          ["agent:research:dashboard", "notes", "agent:research:notes"],
          ["agent:main:dashboard", "notes", "agent:main:notes"],
        ] as const
      ).map(([scopedDashboardSessionKey, override, requestedSessionKey]) => ({
        dashboardSessionKey: scopedDashboardSessionKey,
        props: override ? { sessionKey: override } : undefined,
        response: progressResponse(
          requestedSessionKey,
          "Owned work",
          `Progress for ${requestedSessionKey}`,
        ),
        text: `Progress for ${requestedSessionKey}`,
        requestedSessionKey: !override || override === "global" ? "global" : requestedSessionKey,
        requestedAgentId: requestedSessionKey.split(":")[1],
      })),
    ] as const;

    for (const [index, scenario] of responses.entries()) {
      const request = vi.fn(async () => scenario.response);
      const result = {
        sessions: [
          finishedSession("global", "main", "failed"),
          finishedSession("global", "research", "done"),
          finishedSession("agent:main:notes", "main", "failed"),
          finishedSession("agent:research:notes", "research", "done"),
        ],
      };
      const context = progressContext(request, {
        state: { result },
        ...emptySessions(),
        listSnapshot: () => listSnapshot(result),
      });
      const widget = pluginWidget({
        name: `session-progress-${index}`,
        ...(scenario.props ? { props: scenario.props } : {}),
        position: index,
      });
      const cell = mountCell(widget, {
        context,
        sessionKey: scenario.dashboardSessionKey,
        scopedSession: true,
        active: index !== 0,
      });

      if (index === 0) {
        await cell.updateComplete;
        expect(request).not.toHaveBeenCalled();
        cell.active = true;
      }

      await cell.updateComplete;
      await vi.dynamicImportSettled();
      await waitForRequest(
        request,
        scenario.requestedSessionKey,
        scenario.requestedSessionKey === "global" ? scenario.requestedAgentId : undefined,
        CHUNK_LOAD_WAIT,
      );
      await waitForProgress(cell, scenario.text);
      if (
        (scenario.requestedSessionKey === "global" && scenario.requestedAgentId === "research") ||
        scenario.requestedSessionKey.endsWith(":notes")
      ) {
        expect(cell.querySelector(".session-progress-card__step")?.getAttribute("aria-label")).toBe(
          t("sessionProgressCard.stepLabel", {
            status: t(
              scenario.requestedAgentId === "main"
                ? "sessionProgressCard.status.failed"
                : "sessionProgressCard.status.completed",
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
    const request = vi.fn(async (_method: string, params: { sessionKey: string }) => {
      if (params.sessionKey === deniedSessionKey) {
        throw accessDenied("session is private for this connection");
      }
      attempts += 1;
      if (attempts === 1) {
        throw new Error("session not shared");
      }
      return progressResponse(sessionKey, "Recovered progress");
    });
    const context = progressContext(request, emptySessions(), {
      ...progressGateway(request),
      snapshot: {
        ...progressGateway(request).snapshot,
        hello: { features: { methods: [] }, controlUiWidgetKinds: progressKinds },
      },
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
    });
    const widget = pluginWidget({
      name: "protected-session-progress",
      props: { sessionKey },
    });
    const cell = mountCell(widget, {
      context,
      sessionKey: "agent:main:dashboard",
      scopedSession: true,
    });

    await vi.waitFor(() => expect(progressError(cell)).not.toBeNull(), CHUNK_LOAD_WAIT);
    retryButton(cell)?.click();

    await waitForProgress(cell, "Recovered progress");
    expect(request).toHaveBeenCalledTimes(2);

    const emitChange = () =>
      onEvent?.({
        type: "event",
        event: "progressCard.changed",
        payload: { sessionKey, revision: 2 },
      });
    request.mockRejectedValueOnce(new Error("Refresh temporarily unavailable"));
    emitChange();
    await vi.waitFor(() => expect(progressError(cell)).not.toBeNull());
    expect(visibleCard(cell)?.textContent).toContain("Recovered progress");
    expect(request).toHaveBeenCalledTimes(3);
    cell.session = { ...cell.session! };
    for (const listener of gatewayListeners) {
      listener(context.gateway.snapshot);
    }
    await cell.updateComplete;
    await waitForSolid(() => {
      expect(progressError(cell)).not.toBeNull();
      expect(request).toHaveBeenCalledTimes(3);
    });
    retryButton(cell)?.click();
    await vi.waitFor(() => expect(progressError(cell)).toBeNull());
    expect(visibleCard(cell)?.textContent).toContain("Recovered progress");
    expect(request).toHaveBeenCalledTimes(4);

    request.mockRejectedValueOnce(accessDenied("Participation required"));
    emitChange();
    await vi.waitFor(() =>
      expect(progressError(cell)?.textContent).toContain(
        "Select a session you can access or change sharing for this session.",
      ),
    );
    expect(visibleCard(cell)).toBeNull();
    expect(retryButton(cell)).toBeNull();
    expect(request).toHaveBeenCalledTimes(5);

    cell.widget = { ...widget, props: { sessionKey: deniedSessionKey } };
    await waitForRequest(request, deniedSessionKey);
    await vi.waitFor(
      () =>
        expect(progressError(cell)?.textContent).toContain(
          "Select a session you can access or change sharing for this session.",
        ),
      CHUNK_LOAD_WAIT,
    );
    expect(retryButton(cell)).toBeNull();
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("keeps a board-less running target live on another session's dashboard", async () => {
    const boardOwnerKey = "agent:main:dashboard";
    const boardlessTargetKey = "agent:main:boardless";
    const now = Date.now();
    const targetRow = {
      key: boardlessTargetKey,
      agentId: "main",
      status: "running",
      hasActiveRun: true,
      startedAt: now - 60_000,
    };
    const rosterQueries: Array<{ hasBoard?: boolean }> = [];
    const request = vi.fn(async () =>
      progressResponse(boardlessTargetKey, "Owned work", `Progress for ${boardlessTargetKey}`, now),
    );
    const context = progressContext(request, {
      state: { result: null },
      ...emptySessions(),
      subscribeList: (query: { hasBoard?: boolean }) => {
        rosterQueries.push(query);
        return () => undefined;
      },
      listSnapshot: (query: { hasBoard?: boolean }) =>
        listSnapshot({
          // The Gateway filters hasBoard against each session's own board
          // inventory, so the board-less target only exists in the shared roster.
          sessions: [
            finishedSession(boardOwnerKey, "main", "done"),
            ...(query.hasBoard ? [] : [targetRow]),
          ],
        }),
    });
    const widget = pluginWidget({
      name: "cross-session-progress",
      props: { sessionKey: boardlessTargetKey },
    });
    const cell = mountCell(widget, {
      context,
      sessionKey: boardOwnerKey,
      scopedSession: true,
      active: true,
    });

    await waitForRequest(request, boardlessTargetKey, undefined, CHUNK_LOAD_WAIT);
    const element = progress(cell);
    await vi.waitFor(
      () => expect(element?.querySelector(".session-run-spinner")).not.toBeNull(),
      CHUNK_LOAD_WAIT,
    );
    expect(element?.querySelector(".session-progress-card__step--paused")).toBeNull();
    // Liveness must not depend on dashboard gallery membership.
    expect(rosterQueries.length).toBeGreaterThan(0);
    expect(rosterQueries.every((query) => query.hasBoard === undefined)).toBe(true);
  });
});
