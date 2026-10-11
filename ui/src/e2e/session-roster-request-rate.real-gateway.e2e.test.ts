import { expect, it } from "vitest";
import type {
  RequestFrame,
  ResponseFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.ts";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/schema/sessions.ts";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    // Installed by page.exposeFunction before registering the event observer.
    recordRosterEvent: (label: string) => Promise<void>;
  }
}

let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI session roster request rate with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-session-roster-request-rate",
      config: {
        agents: {
          ownership: "explicit",
          entries: { main: { name: "Main" }, research: { name: "Research" } },
        },
        gateway: { controlUi: { enabled: true } },
      },
    });
    instance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

suite.define(() => {
  it("applies real row events in the page and sidebar before a one-minute fallback", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const emitter = await connectGatewayClient({
      url: owner.url,
      token: owner.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    const key = "agent:main:rate-proof";
    const otherKey = "agent:research:rate-proof";
    try {
      for (const [agentId, sessionKey] of [
        ["main", key],
        ["research", otherKey],
      ] as const) {
        // Dashboard sessions inherit main as parent. A missing parent intentionally
        // prevents complete snapshot certification and requires authoritative reads.
        await emitter.request("sessions.create", { agentId, key: `agent:${agentId}:main` });
        await emitter.request("sessions.create", {
          agentId,
          key: sessionKey,
          label: "Initial rate proof",
        });
      }
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const lists: Array<{ id: string; params: SessionsListParams }> = [];
        const responses = new Set<string>();
        const labels = new Set<string>();
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame = JSON.parse(payload.toString()) as RequestFrame;
            if (frame.type === "req" && frame.method === "sessions.list") {
              lists.push({ id: frame.id, params: frame.params as SessionsListParams });
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame = JSON.parse(payload.toString()) as ResponseFrame;
            if (frame.type === "res" && frame.ok) {
              responses.add(frame.id);
            }
          });
        });
        const url = new URL("sessions", suite.server.baseUrl);
        url.hash = "token=" + encodeURIComponent(owner.gatewayToken);
        expect((await page.goto(url.toString()))?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        const roster = page.locator("openclaw-sessions-page");
        const sidebar = page.locator("openclaw-app-sidebar");
        await roster.getByText("Initial rate proof", { exact: true }).first().waitFor();
        await sidebar.locator('[data-session-key="' + key + '"]').waitFor();
        // Profile counts join bootstrap after the separate navigation summary.
        await expect
          .poll(() =>
            lists.some(
              ({ params }) => params.includeOwnerSessionCounts && params.excludeSubagents === true,
            ),
          )
          .toBe(true);
        await expect.poll(() => lists.every((request) => responses.has(request.id))).toBe(true);
        await page.exposeFunction("recordRosterEvent", (label: string) => {
          labels.add(label);
        });
        await evaluateControlUiContext(page, (context) => {
          // Register after the app's consumers: a raw CDP frame receipt alone
          // does not mean the browser's event handler installed its debounce.
          context.gateway.subscribeEvents((event) => {
            const payload = event.payload as { session?: { label?: string } } | undefined;
            if (event.event === "sessions.changed" && typeof payload?.session?.label === "string") {
              void window.recordRosterEvent(payload.session.label);
            }
          });
        });
        await page.clock.install();
        await pauseVirtualClock(page);
        await page.evaluate(() => {
          Math.random = () => 0;
        });
        // Browser time is controlled; the real server still owns mutation, projection,
        // event delivery, and list responses. Await the delivered row, not patch's ACK.
        const patch = async (sessionKey: string, label: string) => {
          await emitter.request("sessions.patch", { key: sessionKey, label });
          await expect.poll(() => labels.has(label)).toBe(true);
          if (sessionKey === key) {
            // The snapshot-eligible sidebar renders the real event before browser
            // time advances. This also proves the subscription is not inert.
            await expect
              .poll(() => sidebar.locator('[data-session-key="' + key + '"]').textContent())
              .toContain(label);
          }
        };
        const pageReads = () =>
          lists.filter(
            ({ params }) =>
              params.includeUnknown === false &&
              params.includeOwnerSessionCounts !== true &&
              params.includeDerivedTitles === undefined &&
              params.includeLastMessage === undefined,
          );
        const primaryReads = () => lists.filter(({ params }) => params.includeLastMessage === true);
        const pageBefore = pageReads().length;
        const primaryBefore = primaryReads().length;
        expect(pageBefore).toBeGreaterThan(0);
        expect(primaryBefore).toBeGreaterThan(0);
        const before = [...lists];
        await patch(key, "First rate update");
        await roster.getByText("First rate update", { exact: true }).waitFor();
        for (let index = 0; index < 3; index += 1) {
          await patch(key, "Trailing rate update " + index);
          await roster.getByText("Trailing rate update " + index, { exact: true }).waitFor();
          await page.clock.runFor(1_000);
        }
        await page.clock.runFor(56_999);
        expect(lists).toEqual(before);
        // The first row arms the minute fallback, followed by the shared event
        // collection window. Later rows neither refetch nor postpone it.
        await page.clock.runFor(5_001);
        await expect.poll(() => pageReads().length).toBe(pageBefore + 1);
        await expect.poll(() => responses.has(pageReads().at(-1)!.id)).toBe(true);
        await roster.getByText("Trailing rate update 2", { exact: true }).waitFor();
        await expect
          .poll(() => sidebar.locator('[data-session-key="' + key + '"]').textContent())
          .toContain("Trailing rate update 2");
        expect(primaryReads()).toHaveLength(primaryBefore + 1);
        expect(lists.every(({ params }) => params.rowMode === "compact" && params.source)).toBe(
          true,
        );

        expect(pageReads().every(({ params }) => params.agentId === "main")).toBe(true);
        const beforeOther = lists.length;
        await patch(otherKey, "Unrelated rate update");
        await page.clock.runFor(15_000);
        // A changed row in another agent cannot invalidate this page's window.
        const afterOther = lists.slice(beforeOther);
        expect(
          afterOther.filter(({ params }) => params.includeOwnerSessionCounts !== true),
        ).toEqual([]);
        // A relevant successor proves the quiet interval did not retire the
        // subscription. Both events travel through the same real connection.
        await patch(key, "Relevant after unrelated");
        await page.clock.runFor(5_000);
        expect(pageReads()).toHaveLength(pageBefore + 1);
        await roster.getByText("Relevant after unrelated", { exact: true }).waitFor();
        expect(primaryReads()).toHaveLength(primaryBefore + 1);
        await page.clock.resume();
      });
    } finally {
      await disconnectGatewayClient(emitter);
    }
  });
});
