import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { PresencePayload } from "../app/user-profile.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI idle conversation updates" });
const selectedKey = "agent:main:dashboard:idle-conversation";
const foreignKey = "agent:main:dashboard:background-conversation";
const baseTime = 1_900_000_000_000;

type MeasuredPane = HTMLElement & {
  state: Pick<
    ChatPageHost,
    "sessionKey" | "chatMessages" | "chatAvatarStatus" | "modelAuthStatusResult"
  >;
  presence: { readonly snapshot: PresencePayload | undefined };
  render: () => unknown;
  updateComplete: Promise<boolean>;
};

async function observePaneRenders(page: Page) {
  const context = await getControlUiContextHandle(page);
  try {
    return await context.evaluateHandle(
      async (appContext, { foreignKey: observedKey }) => {
        const pane = document.querySelector<MeasuredPane>(
          "openclaw-chat-pane.chat-pane-cache__pane--active",
        );
        const sidebar = document.querySelector<HTMLElement & Pick<MeasuredPane, "updateComplete">>(
          "openclaw-app-sidebar",
        );
        const sessions = appContext.sessions;
        if (!pane || !sidebar || !sessions) {
          throw new Error("The mounted conversation and shared roster must be ready");
        }
        await Promise.all([pane.updateComplete, sidebar.updateComplete]);
        const originalRender = pane.render;
        let renders = 0;
        pane.render = function () {
          renders += 1;
          return originalRender.call(this);
        };
        return {
          pane,
          async read() {
            await Promise.all([pane.updateComplete, sidebar.updateComplete]);
            const count = renders;
            renders = 0;
            return {
              renders: count,
              sharedLabel: sessions.state.result?.sessions.find((row) => row.key === observedKey)
                ?.label,
              selectedKey: pane.state.sessionKey,
              messages: pane.state.chatMessages.length,
              panePresenceTs: pane.presence.snapshot?.presence[0]?.ts,
            };
          },
          restore() {
            pane.render = originalRender;
          },
        };
      },
      { foreignKey },
    );
  } finally {
    await context.dispose();
  }
}

suite.define(() => {
  it("updates the shared roster and viewers without repeatedly redrawing an unchanged conversation", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      // Startup timers must belong to the clock before the app schedules them.
      await page.clock.install();
      const idleModules = [
        "chat-header-panel-menu-content",
        "chat-interaction-runtime",
        "chat-composer-plus-menu-content",
      ];
      const evaluatedModules = new Set<string>();
      page.on("console", (message) => {
        if (message.type() === "debug" && idleModules.includes(message.text())) {
          evaluatedModules.add(message.text());
        }
      });
      await page.route(new RegExp(`/(${idleModules.join("|")})-[^/]+\\.js$`), async (route) => {
        const response = await route.fetch();
        const name = idleModules.find((module) => route.request().url().includes(`/${module}-`));
        const headers = response.headers();
        delete headers["content-length"];
        delete headers["content-encoding"];
        await route.fulfill({
          response,
          headers,
          body: `${await response.text()}\nconsole.debug(${JSON.stringify(name)});`,
        });
      });
      let selected = createControlUiSessionRow(selectedKey, "Foreground conversation", baseTime);
      let foreign = createControlUiSessionRow(foreignKey, "Background conversation", baseTime);
      const gateway = await installMockGateway(page, {
        deferredMethods: ["agent.identity.get", "models.authStatus"],
        sessionKey: selectedKey,
        sessions: [selected, foreign],
        historyMessages: [
          { role: "user", content: "Inspect this workspace", timestamp: baseTime - 2 },
          {
            role: "assistant",
            content: "The retained conversation is ready.",
            timestamp: baseTime - 1,
          },
        ],
        presenceUsers: [
          { self: true, id: "reader", name: "Reader", watchedSessions: [selectedKey] },
          { id: "collaborator", name: "Collaborator", watchedSessions: [] },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedKey));
      await page.getByText("The retained conversation is ready.", { exact: true }).waitFor();
      const backgroundRow = page.locator(`[data-session-key="${foreignKey}"]`);
      await backgroundRow.waitFor({ state: "visible" });
      const mountedPane = await page.evaluateHandle(() =>
        document.querySelector<MeasuredPane>("openclaw-chat-pane.chat-pane-cache__pane--active"),
      );
      // Await both accepted results; virtual time cannot settle their outstanding requests.
      await gateway.waitForRequest("agent.identity.get");
      expect(await mountedPane.evaluate((pane) => pane?.state.chatAvatarStatus)).toBeNull();
      await gateway.resolveDeferred("agent.identity.get");
      await page.waitForFunction((pane) => pane?.state.chatAvatarStatus === "none", mountedPane);
      await gateway.waitForRequest("models.authStatus", { match: { agentId: "main" } });
      expect(await mountedPane.evaluate((pane) => pane?.state.modelAuthStatusResult)).toBeNull();
      await gateway.resolveDeferred("models.authStatus");
      await page.waitForFunction(
        (pane) => pane?.state.modelAuthStatusResult?.providers.length === 0,
        mountedPane,
      );
      await pauseVirtualClock(page);
      // Advance delayed swarm scheduling and queued render frames before measuring events.
      await page.clock.runFor(1_000);
      // Observe evaluation, not preloaded bytes or an earlier network-idle event.
      await expect.poll(() => evaluatedModules.size).toBe(idleModules.length);
      // The shared interaction chunk initializes its catalog in the import continuation.
      // A browser task drains that promise chain before the existing pane commit fence.
      await page.evaluate(async () => {
        const { port1, port2 } = new MessageChannel();
        await new Promise<void>((resolve) => {
          port1.addEventListener("message", () => resolve(), { once: true });
          port1.start();
          port2.postMessage(null);
        });
        port1.close();
        port2.close();
      });
      const probe = await observePaneRenders(page);
      const counts = { foreign: [] as number[], presence: 0, selected: 0, viewer: 0 };
      try {
        const initial = await probe.evaluate((owner) => owner.read());
        expect(initial).toMatchObject({ selectedKey, messages: 2 });
        const publishTitle = async (session: typeof selected) => {
          await gateway.setSessionsListResponse({ sessions: [selected, foreign] });
          await gateway.emitGatewayEvent("sessions.changed", {
            key: session.key,
            sessionKey: session.key,
            agentId: "main",
            reason: "chat.title",
            session,
            ancestorSessions: [],
          });
          // Advance the real frame/debounce owners without wall-clock sleeps.
          await page.clock.runFor(1_000);
        };
        for (let revision = 1; revision <= 3; revision++) {
          const label = `Background revision ${revision}`;
          foreign = createControlUiSessionRow(foreignKey, label, baseTime + revision);
          await publishTitle(foreign);
          const observation = await probe.evaluate((owner) => owner.read());
          counts.foreign.push(observation.renders);
          expect(observation).toMatchObject({ sharedLabel: label, selectedKey, messages: 2 });
          expect(await backgroundRow.textContent()).toContain(label);
        }
        // The first publication can replace an empty-startup presentation memo.
        // Later unrelated publications must not pay for the transcript again.
        expect.soft(counts.foreign[0]).toBeLessThanOrEqual(1);
        expect.soft(counts.foreign.slice(1)).toEqual([0, 0]);

        const heartbeat = await probe.evaluate((owner) => ({
          presence: owner.pane.presence.snapshot!.presence.map((entry) =>
            Object.assign({}, entry, {
              ts: 1_900_000_000_010,
              lastInputSeconds: (entry.lastInputSeconds ?? 0) + 10,
            }),
          ),
        }));
        await gateway.emitGatewayEvent("presence", heartbeat);
        await page.clock.runFor(1_000);
        const presence = await probe.evaluate((owner) => owner.read());
        counts.presence = presence.renders;
        expect(presence).toMatchObject({
          panePresenceTs: baseTime + 10,
        });
        expect.soft(counts.presence).toBe(0);

        selected = createControlUiSessionRow(selectedKey, "Foreground renamed", baseTime + 11);
        await publishTitle(selected);
        counts.selected = (await probe.evaluate((owner) => owner.read())).renders;
        expect(counts.selected).toBeGreaterThan(0);
        expect(await page.locator(".chat-pane__session-title-text").textContent()).toBe(
          "Foreground renamed",
        );

        await gateway.emitGatewayEvent("presence", {
          presence: heartbeat.presence.map((entry) =>
            entry.user?.id === "collaborator"
              ? Object.assign({}, entry, { watchedSessions: [selectedKey] })
              : entry,
          ),
        });
        await page.clock.runFor(1_000);
        counts.viewer = (await probe.evaluate((owner) => owner.read())).renders;
        expect(counts.viewer).toBeGreaterThan(0);
        const collaborator = '[data-viewer-id="collaborator"]';
        const paneViewer = page.locator(`.chat-pane__presence ${collaborator}`);
        const sidebarViewer = page.locator(
          `openclaw-app-sidebar [data-session-key="${selectedKey}"] ${collaborator}`,
        );
        expect(await paneViewer.count()).toBe(1);
        await expect.poll(() => sidebarViewer.count()).toBe(1);
        console.info(JSON.stringify({ proof: "idle-conversation-event-renders", ...counts }));
      } finally {
        await probe.evaluate((owner) => owner.restore());
        await probe.dispose();
        await mountedPane.dispose();
      }
    });
  });
});
