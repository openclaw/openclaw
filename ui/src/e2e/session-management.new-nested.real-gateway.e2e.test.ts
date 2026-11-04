import { expect, it } from "vitest";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { SessionsListResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureNestedSessionProof,
  openNestedSessionMenu,
} from "./session-management.creation.test-support.ts";

let instance: OpenClawTestInstance | undefined;
const parentKey = "agent:main:nested-session-parent";
const suite = createControlUiE2eSuite({
  name: "Control UI empty nested session with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-new-nested-session",
      config: {
        agents: { ownership: "explicit", entries: { main: { name: "Main" } } },
        gateway: { controlUi: { enabled: true } },
      },
    });
    instance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: "http://127.0.0.1:" + owner.port + "/", close: () => owner.cleanup() };
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
  it("creates and reopens an empty persistent child without running an agent", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const client = await connectGatewayClient({
      url: owner.url,
      token: owner.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      await client.request("sessions.create", {
        key: parentKey,
        agentId: "main",
        label: "Project planning",
      });
      await client.request("chat.inject", {
        sessionKey: parentKey,
        message: "Parent planning history stays in the parent.",
      });
      await suite.withPage({ viewport: { width: 1200, height: 844 } }, async ({ page }) => {
        const requests: { method: string; params?: Record<string, unknown> }[] = [];
        page.on("websocket", (socket) =>
          socket.on("framesent", ({ payload }) => {
            const frame = JSON.parse(payload.toString());
            if (frame.type === "req") {
              requests.push(frame);
            }
          }),
        );
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, parentKey) + "#token=" + owner.gatewayToken,
        );
        await waitForControlUiGatewayReady(page);
        await page
          .getByText("Parent planning history stays in the parent.", { exact: true })
          .waitFor({ state: "visible" });
        const { action } = await openNestedSessionMenu(page, parentKey);
        await captureNestedSessionProof(page, "real-menu");
        await action.click();
        const children = async () =>
          (await client.request<SessionsListResult>("sessions.list", { spawnedBy: parentKey }))
            .sessions;
        await expect.poll(async () => (await children()).length).toBe(1);
        const [child] = await children();
        expect(child).toBeDefined();
        await page.locator('[data-session-key="' + child!.key + '"]').waitFor({ state: "visible" });
        await action.waitFor({ state: "hidden" });
        await page.getByText("No messages yet", { exact: true }).waitFor({ state: "visible" });
        const childHistory = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: child!.key,
        });
        expect(childHistory.messages).toEqual([]);
        expect(child!.hasActiveRun).toBe(false);
        const creates = requests.filter((r) => r.method === "sessions.create");
        expect(creates).toHaveLength(1);
        expect(creates[0]?.params).toMatchObject({ parentSessionKey: parentKey, agentId: "main" });
        expect(creates[0]?.params).not.toHaveProperty("fork");
        expect(
          requests.filter((r) => ["agent", "chat.send", "sessions.spawn"].includes(r.method)),
        ).toEqual([]);
        await captureNestedSessionProof(page, "real-created");
        const childUrl = page.url();
        await page.reload();
        await waitForControlUiGatewayReady(page);
        expect(page.url()).toBe(childUrl);
        await page.locator('[data-session-key="' + child!.key + '"]').waitFor({ state: "visible" });
        await page.getByText("No messages yet", { exact: true }).waitFor({ state: "visible" });
        expect((await children())[0]?.key).toBe(child!.key);
      });
    } finally {
      await disconnectGatewayClient(client);
    }
  });
});
