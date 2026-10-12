import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
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
  presencePayload?: PresencePayload;
  render: () => unknown;
  updateComplete: Promise<boolean>;
};

async function observePaneRenders(page: Page) {
  return page.evaluateHandle(
    async ({ foreignKey: observedKey }) => {
      const app = document.querySelector<
        HTMLElement & { runtime?: { context: ApplicationContext } }
      >("openclaw-app");
      const pane = document.querySelector<MeasuredPane>(
        "openclaw-chat-pane.chat-pane-cache__pane--active",
      );
      const sidebar = document.querySelector<
        HTMLElement & {
          updateComplete: Promise<boolean>;
          sessionData: { presencePayload?: PresencePayload };
        }
      >("openclaw-app-sidebar");
      const sessions = app?.runtime?.context.sessions;
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
            sidebarPresenceTs: sidebar.sessionData.presencePayload?.presence[0]?.ts,
          };
        },
        restore() {
          pane.render = originalRender;
        },
      };
    },
    { foreignKey },
  );
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
      await gateway.waitForRequest("agent.identity.get");
      expect(
        await page.evaluate(
          () =>
            document.querySelector<MeasuredPane>("openclaw-chat-pane.chat-pane-cache__pane--active")
              ?.state.chatAvatarStatus,
        ),
      ).toBeNull();
      await gateway.resolveDeferred("agent.identity.get");
      // Transcript paint precedes the idle avatar read. Its accepted status owns
      // completion; virtual time alone cannot settle an outstanding identity request.
      await page.waitForFunction(
        () =>
          document.querySelector<MeasuredPane>("openclaw-chat-pane.chat-pane-cache__pane--active")
            ?.state.chatAvatarStatus === "none",
      );
      await gateway.waitForRequest("models.authStatus", { match: { agentId: "main" } });
      expect(
        await page.evaluate(
          () =>
            document.querySelector<MeasuredPane>("openclaw-chat-pane.chat-pane-cache__pane--active")
              ?.state.modelAuthStatusResult,
        ),
      ).toBeNull();
      await gateway.resolveDeferred("models.authStatus");
      // Identity completion does not join auth startup. Observe the accepted pane
      // result before attributing its final render to unrelated session events.
      await page.waitForFunction(
        () =>
          document.querySelector<MeasuredPane>("openclaw-chat-pane.chat-pane-cache__pane--active")
            ?.state.modelAuthStatusResult?.providers.length === 0,
      );
      await pauseVirtualClock(page);
      // Advance delayed swarm scheduling and queued render frames before measuring events.
      await page.clock.runFor(1_000);
      const probe = await observePaneRenders(page);
      const counts = { foreign: [] as number[], presence: 0, selected: 0, viewer: 0 };
      try {
        const initial = await probe.evaluate((owner) => owner.read());
        expect(initial).toMatchObject({ selectedKey, messages: 2 });
        for (let revision = 1; revision <= 3; revision++) {
          const label = `Background revision ${revision}`;
          foreign = Object.assign({}, foreign, {
            label,
            displayName: label,
            updatedAt: baseTime + revision,
          });
          await gateway.setSessionsListResponse({ sessions: [selected, foreign] });
          await gateway.emitGatewayEvent("sessions.changed", {
            key: foreignKey,
            sessionKey: foreignKey,
            agentId: "main",
            reason: "chat.title",
            session: foreign,
            ancestorSessions: [],
          });
          // Advance the real frame/debounce owners using virtual time, without wall-clock sleeps.
          await page.clock.runFor(1_000);
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
          presence: owner.pane.presencePayload!.presence.map((entry) =>
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
          sidebarPresenceTs: baseTime + 10,
        });
        expect.soft(counts.presence).toBe(0);

        selected = {
          ...selected,
          label: "Foreground renamed",
          displayName: "Foreground renamed",
          updatedAt: baseTime + 11,
        };
        await gateway.setSessionsListResponse({ sessions: [selected, foreign] });
        await gateway.emitGatewayEvent("sessions.changed", {
          key: selectedKey,
          sessionKey: selectedKey,
          agentId: "main",
          reason: "chat.title",
          session: selected,
          ancestorSessions: [],
        });
        await page.clock.runFor(1_000);
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
        expect(
          await page.locator('.chat-pane__presence [data-viewer-id="collaborator"]').count(),
        ).toBe(1);
        console.info(JSON.stringify({ proof: "idle-conversation-event-renders", ...counts }));
      } finally {
        await probe.evaluate((owner) => owner.restore());
        await probe.dispose();
      }
    });
  });
});
