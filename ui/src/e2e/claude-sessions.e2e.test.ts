import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { textContent } from "./chat-flow.test-support.ts";
import { expectHistoryBoundaryState } from "./chat-history-boundary.test-support.ts";
import {
  expectTranscriptLayoutCommitted,
  hostGroupedNativeCatalogs,
  resumableClaudeCatalog,
} from "./claude-sessions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectVirtualRowPaintProbeLifecycle } from "./virtual-row-anchor.lifecycle.test-support.ts";
import {
  captureTopVisibleVirtualRow,
  expectPaintedVirtualRowAnchor,
  startVirtualRowPaintProbe,
  stopVirtualRowPaintProbe,
  type VirtualRowPaintResult,
  waitForPaintedVirtualRowAnchor,
} from "./virtual-row-anchor.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Claude native session catalog",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const terminalSession = (sessionId: string) => ({
  agentId: "main",
  confined: false,
  cwd: "/workspace",
  sessionId,
  shell: "/bin/zsh",
  title: "claude --resume claude-termi…",
});

function terminalGatewayOptions(sessionId?: string) {
  return {
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "sessions.catalog.list",
      "sessions.catalog.read",
      "terminal.open",
    ],
    methodResponses: {
      "sessions.catalog.list": resumableClaudeCatalog(),
      "sessions.catalog.read": {
        hostId: "gateway:local",
        threadId: "claude-terminal-session",
        items: sessionId ? [] : [{ type: "userMessage", text: "Continue the native session" }],
      },
      "terminal.list": { sessions: [] },
      ...(sessionId ? { "terminal.open": terminalSession(sessionId) } : {}),
    },
    terminalEnabled: true,
  };
}

async function catalogHeaderAffordances(header: Locator) {
  return header.evaluate((element) => {
    const find = (selector: string, root: ParentNode = element) => {
      const target = root.querySelector(selector);
      if (!target) {
        throw new Error(`Missing catalog header affordance: ${selector}`);
      }
      return target;
    };
    const toggle = find(".sidebar-session-group-toggle");
    const actions = find(".sidebar-session-group-actions");
    const toolbarButton = find(".sidebar-session-toolbar__button", element.ownerDocument);
    const actionsStyle = getComputedStyle(actions);
    const toolbarButtonStyle = getComputedStyle(toolbarButton);
    return {
      actionFocusVisible: actions.matches(":focus-visible"),
      actionFocused: document.activeElement === actions,
      actionsColor: actionsStyle.color,
      actionsVisible: Number(actionsStyle.opacity) > 0,
      actionsPointerEvents: actionsStyle.pointerEvents,
      chevronOpacity: getComputedStyle(find(".sidebar-session-group-toggle__icon")).opacity,
      finePointer: matchMedia("(pointer: fine)").matches,
      coarsePointer: matchMedia("(pointer: coarse)").matches,
      focusWithin: element.matches(":focus-within"),
      headerFilled: getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)",
      hoverCapable: matchMedia("(hover: hover)").matches,
      noHover: matchMedia("(hover: none)").matches,
      hovered: element.matches(":hover"),
      providerOpacity: getComputedStyle(find(".sidebar-session-catalog-provider-icon")).opacity,
      toolbarButtonColor: toolbarButtonStyle.color,
      toolbarButtonVisible: Number(toolbarButtonStyle.opacity) > 0,
      toggleFocusVisible: toggle.matches(":focus-visible"),
      toggleFocused: document.activeElement === toggle,
    };
  });
}

async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('[data-session-section="work"]') ??
        document.querySelector('[data-session-section^="catalog:"]'),
      ),
    undefined,
    { timeout: 30_000 },
  );
  if ((await toggle.count()) === 0) {
    return;
  }
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

async function navigateToClaudeCatalog(page: Page) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await expandCodingSection(page);
}

async function triggerClaudeCatalogTerminal(page: Page, options: { force?: boolean } = {}) {
  const row = page.locator('[data-catalog-session-key^="catalog:"]').filter({
    hasText: "Native Claude terminal",
  });
  await row.click({ button: "right", force: options.force });
  await page
    .locator("openclaw-catalog-session-menu")
    .getByRole("menuitem", { name: "Open in terminal", exact: true })
    .click({ force: options.force });
}

async function scrollThread(thread: Locator, top: "start" | "end") {
  await thread.evaluate((element, edge) => {
    element.scrollTop = edge === "start" ? 0 : element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  }, top);
}

async function preservePaintedAnchor(thread: Locator, applyPage: () => Promise<void>) {
  const anchor = await captureTopVisibleVirtualRow(thread);
  await startVirtualRowPaintProbe(thread, anchor);
  let result: VirtualRowPaintResult;
  try {
    await applyPage();
    await waitForPaintedVirtualRowAnchor(thread);
  } finally {
    result = await stopVirtualRowPaintProbe(thread);
  }
  expectPaintedVirtualRowAnchor(anchor, result);
}

suite.define(() => {
  it("shows catalog header affordances only for hover or keyboard-visible focus", async () => {
    await suite.withPage(
      { hasTouch: false, viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.catalog.list",
            "sessions.groups.put",
          ],
          methodResponses: { "sessions.catalog.list": hostGroupedNativeCatalogs() },
        });
        await navigateToClaudeCatalog(page);

        const header = page.locator(
          '[data-session-section="catalog:claude"] .sidebar-recent-sessions__head',
        );
        const toggle = header.locator(".sidebar-session-group-toggle");
        await header.hover();
        await expect
          .poll(() => catalogHeaderAffordances(header))
          .toMatchObject({
            actionsVisible: true,
            actionsPointerEvents: "auto",
            chevronOpacity: "0.75",
            finePointer: true,
            headerFilled: true,
            hoverCapable: true,
            hovered: true,
            providerOpacity: "0",
            toolbarButtonVisible: true,
          });
        const hoverAffordances = await catalogHeaderAffordances(header);
        expect(hoverAffordances.actionsColor).toBe(hoverAffordances.toolbarButtonColor);

        await toggle.click();
        await page.locator(".chat-main__conversation").hover({ position: { x: 40, y: 40 } });
        await expect
          .poll(() => catalogHeaderAffordances(header))
          .toMatchObject({
            actionsVisible: false,
            actionsPointerEvents: "none",
            chevronOpacity: "0",
            focusWithin: true,
            headerFilled: false,
            hovered: false,
            providerOpacity: "1",
            toggleFocusVisible: false,
            toggleFocused: true,
            toolbarButtonVisible: true,
          });
        await page.keyboard.press("Tab");
        await expect
          .poll(() => catalogHeaderAffordances(header))
          .toMatchObject({
            actionFocusVisible: true,
            actionFocused: true,
            actionsVisible: true,
            actionsPointerEvents: "auto",
            chevronOpacity: "0.75",
            focusWithin: true,
            headerFilled: false,
            hovered: false,
            providerOpacity: "0",
          });
      },
    );
  });

  it("groups Claude and Codex sessions by Gateway and paired-node host", async () => {
    const page = await suite.browser.newPage({
      hasTouch: true,
      viewport: { width: 1440, height: 900 },
    });
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: { "sessions.catalog.list": hostGroupedNativeCatalogs() },
    });

    try {
      await navigateToClaudeCatalog(page);
      for (const catalogId of ["claude", "codex"]) {
        const catalogLabel = catalogId === "claude" ? "Claude Code" : "Codex";
        const section = page.locator(`[data-session-section="catalog:${catalogId}"]`);
        const gatewayHost = section.locator('[data-session-catalog-host="gateway:local"]');
        const buildHost = section.locator('[data-session-catalog-host="node:build"]');
        await gatewayHost.getByText(`${catalogLabel} local plan`, { exact: true }).waitFor();
        await buildHost.getByText("Build Node", { exact: true }).waitFor();
        await buildHost.getByText(`${catalogLabel} remote review`, { exact: true }).waitFor();
        expect(await gatewayHost.locator(".sidebar-session-catalog-host__head").count()).toBe(0);
        expect(await gatewayHost.getByText("Gateway Mac", { exact: true }).count()).toBe(0);
        expect(await gatewayHost.locator(".sidebar-recent-session").count()).toBe(1);
        expect(await buildHost.locator(".sidebar-recent-session").count()).toBe(1);
        expect(await section.getByText(`${catalogLabel} local plan`, { exact: true }).count()).toBe(
          1,
        );
      }

      const touchAffordance = await catalogHeaderAffordances(
        page.locator('[data-session-section="catalog:claude"] .sidebar-recent-sessions__head'),
      );
      expect(touchAffordance).toMatchObject({
        actionsVisible: true,
        coarsePointer: true,
        noHover: true,
        providerOpacity: "0",
        chevronOpacity: "0.75",
        toolbarButtonVisible: true,
      });
      expect(touchAffordance.actionsColor).toBe(touchAffordance.toolbarButtonColor);
    } finally {
      await page.close();
    }
  });

  it("shows catalog connection progress until the first terminal output", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...terminalGatewayOptions(),
        deferredMethods: ["terminal.open"],
      });

      await navigateToClaudeCatalog(page);
      await triggerClaudeCatalogTerminal(page);
      expect((await gateway.waitForRequest("terminal.open")).params).toEqual(
        expect.objectContaining({
          catalog: {
            catalogId: "claude",
            hostId: "gateway:local",
            threadId: "claude-terminal-session",
          },
        }),
      );
      const connecting = page.getByRole("status", { name: "Connecting to session…" });
      await connecting.waitFor();
      expect(await page.locator(".tabstrip-tab.is-connecting").count()).toBe(1);

      await gateway.resolveDeferred("terminal.open", terminalSession("claude-terminal-e2e"));
      await expect.poll(() => connecting.count()).toBe(1);
      const terminalOutput = "Claude Code ready\r\n";
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "claude-terminal-e2e",
        seq: terminalOutput.length,
        data: terminalOutput,
      });
      await expect.poll(() => connecting.count()).toBe(0);
      expect(await page.locator(".tabstrip-tab.is-live").count()).toBe(1);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
    });
  });

  it("closes a catalog terminal that produces no output before the deadline", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        terminalGatewayOptions("claude-terminal-timeout"),
      );

      await navigateToClaudeCatalog(page);
      await page.clock.install();
      await triggerClaudeCatalogTerminal(page, { force: true });
      expect((await gateway.waitForRequest("terminal.open")).params).toMatchObject({
        catalog: { catalogId: "claude" },
      });
      await page.getByRole("status", { name: "Connecting to session…" }).waitFor();
      await page
        .locator("openclaw-terminal-panel .tabstrip-tab", {
          hasText: "claude --resume claude-termi…",
        })
        .waitFor();
      const resize = await gateway.waitForRequest("terminal.resize");
      expect(resize.params).toMatchObject({ sessionId: "claude-terminal-timeout" });
      await page.clock.fastForward(30_001);
      await page.clock.runFor(100);

      await page.getByText("Session did not connect within 30 seconds.", { exact: true }).waitFor();
      const close = await gateway.waitForRequest("terminal.close");
      expect(close.params).toEqual({ sessionId: "claude-terminal-timeout" });
      expect(await page.locator("openclaw-terminal-panel .tabstrip-tab").count()).toBe(0);
    });
  });

  it("auto-loads older chat without moving the viewport and disables paired-node continuation", async () => {
    const page = await suite.browser.newPage();
    await page.clock.install();
    const catalogResponse = (threadId: string, name: string, nextCursor?: string) => {
      const catalog = hostGroupedNativeCatalogs().catalogs[0]!;
      const host = Object.assign(catalog.hosts[1]!, {
        hostId: "node:devbox",
        label: "Dev Box",
        nodeId: "devbox",
        ...(nextCursor ? { nextCursor } : {}),
      });
      Object.assign(host.sessions[0]!, { threadId, name, source: "claude-cli", archived: false });
      return { catalogs: [{ ...catalog, hosts: [host] }] };
    };
    const firstCatalogPage = catalogResponse(
      "remote-thread",
      "Remote architecture review",
      "catalog-page-2",
    );
    const firstHost = firstCatalogPage.catalogs[0]!.hosts[0]!;
    firstCatalogPage.catalogs[0]!.hosts.push({
      ...firstHost,
      hostId: "node:exhausted",
      nodeId: "exhausted",
      label: "Exhausted host",
      nextCursor: undefined,
      sessions: [
        { ...firstHost.sessions[0]!, threadId: "retained-thread", name: "Retained remote session" },
      ],
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          cases: [
            {
              match: {
                agentId: "main",
                catalogId: "claude",
                cursors: { "node:devbox": "catalog-page-2" },
              },
              response: catalogResponse("older-remote-thread", "Older remote review"),
            },
            {
              match: {},
              response: firstCatalogPage,
            },
          ],
        },
        "sessions.catalog.read": {
          cases: [
            {
              match: { cursor: "older" },
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: [{ id: "a0", type: "agentMessage", text: "older question" }],
              },
            },
            {
              match: {},
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: Array.from({ length: 40 }, (_, index) => ({
                  id: `a${index + 1}`,
                  type: index % 2 === 0 ? "agentMessage" : "userMessage",
                  text:
                    index === 0
                      ? "newer answer"
                      : `recent transcript message ${index + 1} with enough text to fill the pane`,
                })),
                nextCursor: "older",
              },
            },
          ],
        },
      },
    });
    await navigateToClaudeCatalog(page);
    const catalog = page.locator('[data-session-section="catalog:claude"]');
    await catalog.getByRole("link", { name: "Retained remote session", exact: true }).waitFor();
    const initialCatalogRequest = (await gateway.getRequests("sessions.catalog.list"))[0]?.params;
    expect(initialCatalogRequest).toMatchObject({ agentId: "main", limitPerHost: 40 });
    expect(initialCatalogRequest).not.toHaveProperty("hostIds");
    await page.locator('[data-session-catalog-load-more="claude"]').click();
    await catalog.getByRole("link", { name: "Older remote review", exact: true }).waitFor();
    await catalog.getByRole("link", { name: "Retained remote session", exact: true }).waitFor();
    const pageRequest = {
      agentId: "main",
      catalogId: "claude",
      hostIds: ["node:devbox"],
      cursors: { "node:devbox": "catalog-page-2" },
    };
    expect((await gateway.getRequests("sessions.catalog.list")).at(-1)?.params).toEqual(
      pageRequest,
    );
    const catalogRequestCount = (await gateway.getRequests("sessions.catalog.list")).length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.runFor(50);
    expect((await gateway.getRequests("sessions.catalog.list")).length).toBe(catalogRequestCount);
    await page.clock.fastForward(120_000);
    await page.clock.runFor(100);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
      .toBeGreaterThanOrEqual(catalogRequestCount + 1);
    const catalogPageMatch = {
      catalogId: "claude",
      cursors: { "node:devbox": "catalog-page-2" },
    };
    await expect
      .poll(
        async () => (await gateway.getRequests("sessions.catalog.list", catalogPageMatch)).length,
      )
      .toBeGreaterThanOrEqual(2);
    for (const request of await gateway.getRequests("sessions.catalog.list", catalogPageMatch)) {
      expect(request.params).toEqual(pageRequest);
    }
    await catalog.getByRole("link", { name: "Retained remote session", exact: true }).waitFor();
    await catalog.getByRole("link", { name: "Older remote review", exact: true }).waitFor();
    const remote = catalog.getByRole("link", { name: /^Remote architecture review$/ });
    await remote.hover();
    await page.locator(".session-progress-hovercard").waitFor();
    await remote.click();
    await expect.poll(() => page.getByText("newer answer", { exact: true }).count()).toBe(1);
    const catalogPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    const thread = catalogPane.locator(".chat-thread");
    await expect
      .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 100))
      .toBe(true);
    await scrollThread(thread, "end");
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const initialReadCount = (await gateway.getRequests("sessions.catalog.read")).length;
    await gateway.deferNext("sessions.catalog.read");
    // Reader input cancels pending restoration; a direct scrollTop write can
    // be overwritten before the history sentinel observes the top boundary.
    await thread.hover();
    await page.mouse.wheel(0, -10_000);
    await page.clock.runFor(100);
    await catalogPane.locator(".chat-virtual-row").first().waitFor();
    await expect
      .poll(() => gateway.getRequests("sessions.catalog.read").then((requests) => requests.length))
      .toBe(initialReadCount + 1);
    await expectHistoryBoundaryState(catalogPane, true);
    await preservePaintedAnchor(thread, async () => {
      await gateway.resolveDeferred("sessions.catalog.read");
      await expect
        .poll(() =>
          catalogPane.evaluate(
            (element) =>
              (element as HTMLElement & { catalogMessages: unknown[] }).catalogMessages.length,
          ),
        )
        .toBe(41);
      await page.clock.runFor(100);
    });
    expect(
      await catalogPane.locator(".agent-chat__composer-combobox > textarea").isDisabled(),
    ).toBe(true);
    await expect
      .poll(() => page.getByText("This session is on a paired device and is view-only.").count())
      .toBe(1);
    const expectCenteredLayout = async () => {
      await expectTranscriptLayoutCommitted(thread);
      // Sample all centers in one browser turn so they describe the same layout.
      const [workbenchCenter, ...centers] = await catalogPane.evaluate((element) =>
        [".chat-workbench", ".chat-thread-inner", ".agent-chat__composer-shell"].map((selector) => {
          const target = element.querySelector(selector);
          const box = target?.getBoundingClientRect();
          return target &&
            getComputedStyle(target).visibility === "visible" &&
            box &&
            box.width > 0 &&
            box.height > 0
            ? box.x + box.width / 2
            : null;
        }),
      );
      expect(workbenchCenter).not.toBeNull();
      for (const center of centers) {
        expect(center).not.toBeNull();
        expect(Math.abs(center! - workbenchCenter!)).toBeLessThanOrEqual(1);
      }
    };
    await expectCenteredLayout();
    await page.setViewportSize({ width: 1600, height: 900 });
    await expectCenteredLayout();
    expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
      catalogId: "claude",
      cursor: "older",
    });
    const exhaustedReadCount = (await gateway.getRequests("sessions.catalog.read")).length;
    await thread.hover();
    await page.mouse.wheel(0, -10_000);
    await page.clock.runFor(100);
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
    await expect.poll(() => page.getByText("older question", { exact: true }).count()).toBe(1);
    await page.clock.runFor(500);
    expect(await catalogPane.locator(".chat-history-sentinel").count()).toBe(0);
    expect(await catalogPane.getByRole("button", { name: "Show earlier" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(exhaustedReadCount);
    await page.close();
  });

  it("keeps the earlier-history action vertically stable while loading and preserves the reader after retry", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1280, height: 800 } });
    const historyMessage = (seq: number, prefix: string) => ({
      __openclaw: { seq },
      content: textContent(`${prefix} ${seq}\n${"transcript detail line\n".repeat(3)}`),
      role: seq % 2 === 0 ? "assistant" : "user",
      timestamp: Date.now() + seq,
    });
    const recent = Array.from({ length: 100 }, (_, index) =>
      historyMessage(index + 1001, "recent native message"),
    );
    const older = Array.from({ length: 1000 }, (_, index) =>
      historyMessage(index + 1, "older native message"),
    );
    const historyPage = (
      messages: ReturnType<typeof historyMessage>[],
      totalMessages = 1100,
      nextOffset?: number,
    ) => ({
      messages,
      totalMessages,
      hasMore: nextOffset !== undefined,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      sessionId: "native-scrollback",
      thinkingLevel: null,
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": historyPage(recent, 1100, 100),
        "chat.history": {
          cases: [
            { match: { offset: 100 }, response: historyPage(older) },
            { match: { offset: 1100 }, response: historyPage([], 1140) },
          ],
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText(/^recent native message 1100\n/).waitFor();
    const thread = page.locator(".chat-thread");
    await expect
      .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 100))
      .toBe(true);
    await scrollThread(thread, "end");
    const showEarlier = page.getByRole("button", { name: "Show earlier" });
    // The in-flow boundary starts above the viewport.
    expect(await showEarlier.count()).toBe(1);
    expect((await showEarlier.boundingBox())?.y ?? 0).toBeLessThan(0);
    const initialRequestCount = (await gateway.getRequests("chat.history")).length;
    await gateway.deferNext("chat.history");
    await scrollThread(thread, "start");
    // Exclude load-time and prior-page requests on slow runners.
    await gateway.waitForRequest("chat.history", { after: initialRequestCount });
    await page.locator('.chat-history-boundary__action[aria-busy="true"]').waitFor();
    const loadingEarlier = await expectHistoryBoundaryState(page, true);
    const loadingHistoryAction = await loadingEarlier.boundingBox();
    expect(loadingHistoryAction).not.toBeNull();
    await gateway.rejectDeferred("chat.history", {
      code: "UNAVAILABLE",
      message: "history unavailable",
      retryable: true,
    });
    await expect.poll(() => showEarlier.getAttribute("aria-busy")).toBe("false");
    await expectHistoryBoundaryState(page, false);
    // Rejection leaves the idle action in the same viewport for comparison.
    const idleHistoryAction = await showEarlier.boundingBox();
    expect(idleHistoryAction).not.toBeNull();
    expect(loadingHistoryAction?.y).toBeCloseTo(idleHistoryAction?.y ?? 0, 0);
    expect(loadingHistoryAction?.height).toBeCloseTo(idleHistoryAction?.height ?? 0, 0);
    expect((loadingHistoryAction?.x ?? 0) + (loadingHistoryAction?.width ?? 0) / 2).toBeCloseTo(
      (idleHistoryAction?.x ?? 0) + (idleHistoryAction?.width ?? 0) / 2,
      0,
    );
    const failedRequestCount = (await gateway.getRequests("chat.history")).length;
    await gateway.deferNext("chat.history");
    await showEarlier.click();
    await gateway.waitForRequest("chat.history", { after: failedRequestCount });
    await page.locator('.chat-history-boundary__action[aria-busy="true"]').waitFor();
    await expectHistoryBoundaryState(page, true);
    expect(await gateway.getRequests("chat.history")).toHaveLength(failedRequestCount + 1);
    await preservePaintedAnchor(thread, async () => {
      await gateway.resolveDeferred("chat.history", historyPage(older, 1140, 1100));
      await expect
        .poll(() =>
          page
            .locator("openclaw-chat-pane")
            .evaluate(
              (element) =>
                (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                  .length,
            ),
        )
        .toBe(1100);
      await expectHistoryBoundaryState(page, false);
    });
    // Stage offset 1100 without entering the loading state.
    await expect
      .poll(() => gateway.getRequests("chat.history").then((requests) => requests.length))
      .toBe(failedRequestCount + 2);
    const requestsAfterPrefetch = await gateway.getRequests("chat.history");
    expect(requestsAfterPrefetch.at(-2)?.params).toMatchObject({ limit: 1000, offset: 100 });
    expect(requestsAfterPrefetch.at(-1)?.params).toMatchObject({ limit: 1000, offset: 1100 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    // Single staging slot: the parked page must not chain further prefetches.
    expect(await gateway.getRequests("chat.history")).toHaveLength(failedRequestCount + 2);
    // Consume the staged page without a round trip or new upward scroll intent.
    await thread.evaluate((element) => {
      element.querySelector<HTMLButtonElement>(".chat-history-boundary__action")?.click();
    });
    await expect.poll(() => page.locator(".chat-history-sentinel").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Show earlier" }).count()).toBe(0);
    expect(await gateway.getRequests("chat.history")).toHaveLength(failedRequestCount + 2);
    await page.close();
  });

  it("seals completed paint evidence and retains queued anchor jumps", () =>
    suite.withPage(undefined, ({ page }) => expectVirtualRowPaintProbeLifecycle(page)));
});
