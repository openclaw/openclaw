import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import path from "node:path";
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
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const agentId = "acp-unlisted";
const key = `agent:${agentId}:acp:00000000-0000-4000-8000-000000000001`;
const mainKey = "agent:main:main";
const label = "Unlisted ACP session";
const transcript = "Retained ACP transcript after owner removal";
let instance: OpenClawTestInstance | undefined;

function configFor(owner: OpenClawTestInstance, includeAcpOwner: boolean) {
  return {
    agents: {
      ownership: "explicit",
      defaults: { model: { primary: "openai/gpt-5.6-luna" } },
      entries: {
        main: { name: "Main" },
        writer: { name: "Writer" },
        ...(includeAcpOwner ? { [agentId]: { name: "ACP worker" } } : {}),
      },
    },
    acp: { defaultAgent: agentId, allowedAgents: [agentId] },
    gateway: {
      port: owner.port,
      auth: { mode: "token", token: owner.gatewayToken },
      controlUi: { enabled: true, root: path.resolve(process.cwd(), "dist/control-ui") },
    },
    plugins: { enabled: false },
    browser: { enabled: false },
    update: { checkOnStart: false },
  };
}

async function rejectionCode(request: Promise<unknown>): Promise<string> {
  try {
    await request;
    return "ACCEPTED";
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return typeof code === "string" ? code : error instanceof Error ? error.name : "UNKNOWN";
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI deleted ACP owner against a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-deleted-acp-owner",
      config: {
        agents: {
          ownership: "explicit",
          defaults: { model: { primary: "openai/gpt-5.6-luna" } },
          entries: {
            main: { name: "Main" },
            writer: { name: "Writer" },
            [agentId]: { name: "ACP worker" },
          },
        },
        acp: { defaultAgent: agentId, allowedAgents: [agentId] },
        gateway: {
          controlUi: { enabled: true, root: path.resolve(process.cwd(), "dist/control-ui") },
        },
        plugins: { enabled: false },
        browser: { enabled: false },
        update: { checkOnStart: false },
      },
    });
    instance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      return runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
    }
  },
});

suite.define(() => {
  it("lists, opens, and deletes a retained ACP session after its agent is removed", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const seedClient = await connectGatewayClient({
      url: owner.url,
      token: owner.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    let created: { sessionId: string };
    try {
      created = await seedClient.request<{ sessionId: string }>("sessions.create", {
        key,
        agentId,
        label,
      });
      await seedClient.request("chat.inject", { sessionKey: key, agentId, message: transcript });
    } finally {
      await disconnectGatewayClient(seedClient);
    }

    await owner.stopGateway();
    await owner.state.writeConfig(configFor(owner, false));
    await owner.startGateway();

    const client = await connectGatewayClient({
      url: owner.url,
      token: owner.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      const list = () =>
        client.request<SessionsListResult>("sessions.list", {
          includeGlobal: true,
          includeUnknown: true,
          configuredAgentsOnly: true,
        });
      const listedRows = (await list()).sessions;
      const listedBefore = listedRows.some((row) => row.key === key);
      expect(
        listedBefore,
        JSON.stringify(listedRows.map((row) => ({ key: row.key, agentId: row.agentId }))),
      ).toBe(true);

      const freshKey = `agent:${agentId}:acp:${randomUUID()}`;
      const createCode = await rejectionCode(
        client.request("sessions.create", { key: freshKey, agentId, label: "Must reject" }),
      );
      const explicitGetCode = await rejectionCode(
        client.request("sessions.get", { key, agentId, limit: 100 }),
      );
      const explicitHistoryCode = await rejectionCode(
        client.request("chat.history", { sessionKey: key, agentId, limit: 100 }),
      );
      expect(createCode).toBe("INVALID_REQUEST");
      expect(explicitGetCode).toBe("INVALID_REQUEST");
      expect(explicitHistoryCode).toBe("INVALID_REQUEST");
      const keyOnlyHistory = await client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey: key,
        limit: 100,
      });
      expect(JSON.stringify(keyOnlyHistory.messages)).toContain(transcript);
      await client.request("sessions.get", { key, limit: 100 });

      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
          page.on("websocket", (socket) =>
            socket.on("framesent", ({ payload }) => {
              try {
                const frame = JSON.parse(payload.toString()) as {
                  type?: string;
                  method?: string;
                  params?: unknown;
                };
                if (frame.type !== "req" || typeof frame.method !== "string") {
                  return;
                }
                requests.push({
                  method: frame.method,
                  params:
                    frame.params && typeof frame.params === "object"
                      ? (frame.params as Record<string, unknown>)
                      : undefined,
                });
              } catch {
                // Ignore non-JSON transport frames.
              }
            }),
          );
          await page.goto(
            `${controlUiSessionUrl(suite.server.baseUrl, mainKey)}#token=${encodeURIComponent(owner.gatewayToken)}`,
          );
          await waitForControlUiGatewayReady(page);
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-agent-card__main").click();
          await sidebar.locator('[data-value="scope:all"]').click();
          const row = page.locator(".session-data-row").filter({ hasText: label });
          await row.waitFor({ state: "visible" });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(suite.artifactDir, "all-agents-listed-acp-session.png"),
          });

          const resolvesBeforeOpen = requests.filter(
            (request) => request.method === "sessions.resolve",
          ).length;
          await row.locator(".session-link").click();
          await expect
            .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().sessionKey))
            .toBe(key);
          const subscription = requests.findLast(
            (request) =>
              request.method === "sessions.messages.subscribe" && request.params?.key === key,
          );
          expect(subscription?.params).not.toHaveProperty("initialHistory");
          await expect
            .poll(() =>
              requests.some(
                (request) =>
                  ["chat.history", "chat.startup"].includes(request.method) &&
                  request.params?.sessionKey === key,
              ),
            )
            .toBe(true);
          const history = requests.findLast(
            (request) =>
              ["chat.history", "chat.startup"].includes(request.method) &&
              request.params?.sessionKey === key,
          );
          expect(history?.params).not.toHaveProperty("agentId");
          await page.getByText(transcript, { exact: true }).waitFor({ state: "visible" });
          await expect
            .poll(() =>
              requests.some(
                (request) =>
                  request.method === "sessions.messages.subscribe" && request.params?.key === key,
              ),
            )
            .toBe(true);
          expect(subscription?.params).not.toHaveProperty("agentId");
          expect(requests.filter((request) => request.method === "sessions.resolve")).toHaveLength(
            resolvesBeforeOpen,
          );
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(suite.artifactDir, "opened-acp-session.png"),
          });

          await page.locator(".chat-header-session-menu__trigger").last().click();
          await support.openSessionMenuSubmenu(page, "Advanced");
          await support.activateSelfRemovingControl(
            ui.menuItem(page.locator("openclaw-chat-header-session-menu"), "Delete…", false),
          );
          const confirmation = await support.waitForConfirmModal(page);
          await ui.button(confirmation, "Delete").click();
          await expect
            .poll(() =>
              requests.some(
                (request) => request.method === "sessions.delete" && request.params?.key === key,
              ),
            )
            .toBe(true);
          const deletion = requests.findLast(
            (request) => request.method === "sessions.delete" && request.params?.key === key,
          );
          expect(deletion?.params).toMatchObject({
            deleteTranscript: true,
            expectedSessionId: created.sessionId,
            key,
          });
          expect(deletion?.params).not.toHaveProperty("agentId");
        },
      );

      await expect
        .poll(async () => (await list()).sessions.some((row) => row.key === key))
        .toBe(false);
      writeSync(
        1,
        `[pr-199398-live-proof] gateway=isolated-local owner-removed=true listed=true opened=true subscribe-agentId=omitted history-agentId=omitted fresh-create=${createCode} explicit-get=${explicitGetCode} explicit-history=${explicitHistoryCode} delete-agentId=omitted listed-after-delete=false\n`,
      );
    } finally {
      await disconnectGatewayClient(client);
    }
  });
});
