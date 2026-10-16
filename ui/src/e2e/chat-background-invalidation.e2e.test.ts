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
const paneSelector = "openclaw-chat-pane.chat-pane-cache__pane--active";

type MeasuredPane = HTMLElement & {
  state: Pick<
    ChatPageHost,
    "sessionKey" | "chatMessages" | "chatAvatarStatus" | "modelAuthStatusResult"
  >;
  presencePayload?: PresencePayload;
  render: () => unknown;
  updateComplete: Promise<boolean>;
};

async function observePaneRenders(page: Page) {
  const context = await getControlUiContextHandle(page);
  try {
    return await context.evaluateHandle(
      async (appContext, { foreignKey: observedKey, paneSelector: selector }) => {
        const pane = document.querySelector<MeasuredPane>(selector);
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
              panePresenceTs: pane.presencePayload?.presence[0]?.ts,
            };
          },
          restore() {
            pane.render = originalRender;
          },
        };
      },
      { foreignKey, paneSelector },
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
      let selected = createControlUiSessionRow(selectedKey, "Foreground conversation", baseTime);
      let foreign = createControlUiSessionRow(foreignKey, "Background conversation", baseTime);
      const gateway = await installMockGateway(page, {
        deferredMethods: ["agent.identity.get", "models.authStatus"],
        sessionKey: selectedKey,
        sessions: [selected, foreign],
        historyMessages: [
          { role: "user", content: "Inspect this workspace", timestamp: baseTime - 2 },
          { role: "assistant", content: "Retained chat ready.", timestamp: baseTime - 1 },
        ],
        presenceUsers: [
          { self: true, id: "reader", name: "Reader", watchedSessions: [selectedKey] },
          { id: "collaborator", name: "Collaborator", watchedSessions: [] },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedKey));
      await page.getByText("Retained chat ready.", { exact: true }).waitFor();
      const backgroundRow = page.locator(`[data-session-key="${foreignKey}"]`);
      await backgroundRow.waitFor({ state: "visible" });
      // Both independent startup reads must settle before attributing renders to events.
      const pane = page.locator(paneSelector);
      for (const method of ["agent.identity.get", "models.authStatus"]) {
        const field =
          method === "agent.identity.get" ? "chatAvatarStatus" : "modelAuthStatusResult";
        await gateway.waitForRequest(
          method,
          method === "models.authStatus" ? { match: { agentId: "main" } } : undefined,
        );
        expect(
          await pane.evaluate((element: MeasuredPane, key) => element.state[key], field),
        ).toBeNull();
        await gateway.resolveDeferred(method);
        await page.waitForFunction(
          ({ paneSelector: selector, field: key }) => {
            const state = document.querySelector<MeasuredPane>(selector)?.state;
            return key === "chatAvatarStatus"
              ? state?.chatAvatarStatus === "none"
              : state?.modelAuthStatusResult?.providers.length === 0;
          },
          { paneSelector, field },
        );
      }
      await pauseVirtualClock(page);
      // Advance delayed swarm scheduling and queued render frames before measuring events.
      await page.clock.runFor(1_000);
      const probe = await observePaneRenders(page);
      const foreignRenders: number[] = [];
      async function readAfterEvent() {
        await page.clock.runFor(1_000);
        return probe.evaluate((owner) => owner.read());
      }
      async function rename(session: typeof selected, label: string, revision: number) {
        const updated = { ...session, label, displayName: label, updatedAt: baseTime + revision };
        if (session.key === selectedKey) {
          selected = updated;
        } else {
          foreign = updated;
        }
        await gateway.setSessionsListResponse({ sessions: [selected, foreign] });
        await gateway.emitGatewayEvent("sessions.changed", {
          key: session.key,
          sessionKey: session.key,
          agentId: "main",
          reason: "chat.title",
          session: updated,
          ancestorSessions: [],
        });
        return readAfterEvent();
      }
      try {
        const initial = await probe.evaluate((owner) => owner.read());
        expect(initial).toMatchObject({ selectedKey, messages: 2 });
        for (let revision = 1; revision <= 3; revision++) {
          const label = `Background revision ${revision}`;
          const observation = await rename(foreign, label, revision);
          foreignRenders.push(observation.renders);
          expect(observation).toMatchObject({ sharedLabel: label, selectedKey, messages: 2 });
          expect(await backgroundRow.textContent()).toContain(label);
        }
        // The first publication can replace an empty-startup presentation memo.
        // Later unrelated publications must not pay for the transcript again.
        expect.soft(foreignRenders[0]).toBeLessThanOrEqual(1);
        expect.soft(foreignRenders.slice(1)).toEqual([0, 0]);

        const heartbeat = await probe.evaluate((owner) => ({
          presence: owner.pane.presencePayload!.presence.map((entry) =>
            Object.assign({}, entry, {
              ts: 1_900_000_000_010,
              lastInputSeconds: (entry.lastInputSeconds ?? 0) + 10,
            }),
          ),
        }));
        await gateway.emitGatewayEvent("presence", heartbeat);
        const presence = await readAfterEvent();
        expect(presence).toMatchObject({ panePresenceTs: baseTime + 10 });
        expect.soft(presence.renders).toBe(0);

        const title = "Foreground renamed";
        expect((await rename(selected, title, 11)).renders).toBeGreaterThan(0);
        expect(await page.locator(".chat-pane__session-title-text").textContent()).toBe(title);

        await gateway.emitGatewayEvent("presence", {
          presence: heartbeat.presence.map((entry) =>
            entry.user?.id === "collaborator"
              ? Object.assign({}, entry, { watchedSessions: [selectedKey] })
              : entry,
          ),
        });
        expect((await readAfterEvent()).renders).toBeGreaterThan(0);
        const viewer = '[data-viewer-id="collaborator"]';
        expect(await page.locator(`.chat-pane__presence ${viewer}`).count()).toBe(1);
        const sidebarSession = page.locator(
          `openclaw-app-sidebar [data-session-key="${selectedKey}"]`,
        );
        await expect.poll(() => sidebarSession.locator(viewer).count()).toBe(1);
      } finally {
        await probe.evaluate((owner) => owner.restore());
        await probe.dispose();
      }
    });
  });
});
