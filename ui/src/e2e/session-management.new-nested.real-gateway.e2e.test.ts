import { expect, it } from "vitest";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.ts";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { SessionsListResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
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
  it("reconciles captured selections across real refresh, removal, and successor updates", async () => {
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
    const replaced = "agent:main:selection-proof-replaced";
    const retained = "agent:main:selection-proof-retained";
    const removed = "agent:main:selection-proof-removed";
    const keys = [replaced, retained, removed];
    try {
      for (const key of keys) {
        await client.request("sessions.create", { key, agentId: "main", label: key });
      }
      const initial = await client.request<SessionsListResult>("sessions.list", {
        agentId: "main",
      });
      const originalId = (key: string) => {
        const id = initial.sessions.find((row) => row.key === key)?.sessionId;
        if (!id) {
          throw new Error("Synthetic selection fixture is missing a session identity");
        }
        return id;
      };
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const deletes: unknown[] = [];
        const deleteRequests = new Set<string>();
        const deleteResponse = createDeferredCore<unknown>();
        const listRequests: string[] = [];
        let listResponses = 0;
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame = JSON.parse(payload.toString());
            if (frame.type === "req" && frame.method === "sessions.delete") {
              deletes.push(frame.params);
              deleteRequests.add(frame.id);
            }
            if (
              frame.type === "req" &&
              frame.method === "sessions.list" &&
              frame.params?.source === "sessions-page"
            ) {
              listRequests.push(frame.id);
            }
          });
          socket.on("framereceived", ({ payload }) => {
            const frame = JSON.parse(payload.toString());
            if (frame.type === "res" && deleteRequests.has(frame.id)) {
              deleteResponse.resolve(frame);
            }
            if (frame.type === "res" && frame.ok && listRequests.includes(frame.id)) {
              listResponses++;
            }
          });
        });
        await page.goto(suite.server.baseUrl + "sessions#token=" + owner.gatewayToken);
        await waitForControlUiGatewayReady(page);
        const roster = page.locator("openclaw-sessions-page");
        const checkbox = (key: string) =>
          roster.locator(`input[type="checkbox"][aria-label$=": ${key}"]`);
        for (const key of keys) {
          await checkbox(key).check();
        }
        const beforeRefresh = listResponses;
        await roster.locator(".sessions-toolbar__refresh").click();
        await expect.poll(() => listResponses).toBeGreaterThan(beforeRefresh);
        for (const key of keys) {
          await expect.poll(() => checkbox(key).isChecked()).toBe(true);
        }
        await roster.locator(".data-table-bulk-bar .danger").click();
        const confirmation = await waitForConfirmModal(page);
        // deleteSelected captured its rows before this real owner publication.
        // Its post-confirmation reference check must still admit the retained row.
        await client.request("sessions.patch", {
          key: retained,
          label: "Retained selection refreshed",
        });
        await roster.getByText("Retained selection refreshed", { exact: true }).waitFor();
        for (const key of [removed, replaced]) {
          expect(
            await client.request("sessions.delete", { key, expectedSessionId: originalId(key) }),
          ).toMatchObject({ deleted: true });
        }
        await client.request("sessions.create", {
          key: replaced,
          agentId: "main",
          label: "Selection successor",
        });
        await roster.getByText("Selection successor", { exact: true }).waitFor();
        await expect.poll(() => checkbox(removed).count()).toBe(0);
        await expect.poll(() => checkbox(replaced).isChecked()).toBe(false);
        await expect.poll(() => checkbox(retained).isChecked()).toBe(true);
        await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
        await expect.poll(() => checkbox(retained).count()).toBe(0);
        // Pending deletion hides the row before the Gateway commits it.
        // Await the matching UI response before reading through another client.
        expect(await deleteResponse.promise).toMatchObject({
          ok: true,
          payload: { deleted: true },
        });
        expect(deletes).toEqual([
          expect.objectContaining({ key: retained, expectedSessionId: originalId(retained) }),
        ]);
        const final = await client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
        });
        const successor = final.sessions.find((row) => row.key === replaced);
        expect(successor?.sessionId).toBeTruthy();
        expect(successor?.sessionId).not.toBe(originalId(replaced));
        expect(final.sessions.some((row) => row.key === removed || row.key === retained)).toBe(
          false,
        );
      });
    } finally {
      await disconnectGatewayClient(client);
    }
  });

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
