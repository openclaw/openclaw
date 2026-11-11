import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import type {
  RequestFrame,
  ResponseFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.ts";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/schema/sessions.ts";
import { writeToolCall } from "../../../src/gateway/gateway-provider-fixture.test-support.ts";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.ts";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
} from "../../../src/state/user-profiles.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

declare global {
  interface Window {
    recordRosterEvent: (label: string) => Promise<void>;
  }
}

let instance: OpenClawTestInstance | undefined;
let viewerId: string;
let otherOwnerId: string;
const modelResponses: ServerResponse[] = [];
const suite = createControlUiE2eSuite({
  name: "Control UI session roster request rate with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    let modelRequests = 0;
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume().once("end", () => {
            modelRequests++;
            if (modelRequests <= 2 && instance) {
              writeToolCall(response, "write", {
                path: path.join(instance.state.workspaceDir, `roster-tool-${modelRequests}.txt`),
                content: "Synthetic roster tool proof",
              });
            } else {
              modelResponses.push(response);
            }
          });
        }),
    });
    const close = () =>
      runQaGatewayFixture(
        async () => {},
        () => instance?.cleanup(),
        async () => {
          provider.listener.closeAllConnections();
          await provider.releaseListener();
        },
        () => provider.claim.release(),
      );
    try {
      const owner = await createOpenClawTestInstance({
        name: "control-ui-session-roster-request-rate",
        env: { VITEST: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
        config: {
          agents: {
            ownership: "explicit",
            defaults: {
              model: "roster-fixture/echo",
              models: { "roster-fixture/echo": { agentRuntime: { id: "openclaw" } } },
              skipBootstrap: true,
              skills: [],
            },
            entries: { main: { name: "Main" }, research: { name: "Research" } },
          },
          models: {
            providers: {
              "roster-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-roster-key",
                baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: [{ id: "echo", name: "Fixture" }],
              },
            },
          },
          plugins: { allow: [] },
          cron: { enabled: false },
          gateway: { controlUi: { enabled: true } },
        },
      });
      instance = owner;
      viewerId = ensureGatewayOwnerProfile("Roster viewer", { env: owner.env }).id;
      otherOwnerId = ensureProfileForEmail("roster-other@example.test", { env: owner.env }).id;
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close };
    } catch (error) {
      await runQaGatewayFixture(async () => {
        throw error;
      }, close);
      throw error;
    }
  },
});

suite.define(() => {
  it("applies real row events in the page and sidebar without periodic list reads", async () => {
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
    const foreignKey = "agent:main:foreign-owner-rate-proof";
    try {
      for (const [agentId, sessionKey] of [
        ["main", key],
        ["research", otherKey],
      ] as const) {
        // Missing parents prevent snapshot certification and force authoritative reads.
        await emitter.request("sessions.create", { agentId, key: `agent:${agentId}:main` });
        await emitter.request("sessions.create", {
          agentId,
          key: sessionKey,
          label: "Initial rate proof",
        });
      }
      for (const sessionKey of [foreignKey, foreignKey + "-second"]) {
        await emitter.request("sessions.create", {
          key: sessionKey,
          label: "Other owner's session " + sessionKey,
        });
        await emitter.request("sessions.assignOwner", {
          key: sessionKey,
          owner: { type: "human", id: otherOwnerId },
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
        const selected = sidebar.locator(`[data-session-key="${key}"]`);
        await roster.getByText("Initial rate proof", { exact: true }).first().waitFor();
        await chooseSidebarOwner(page, "owner:" + viewerId);
        await expect
          .poll(() =>
            [
              lists.find(
                ({ params }) => params.source === "sidebar" && params.ownerId === viewerId,
              ),
              lists.find(
                ({ params }) =>
                  params.source === "sidebar" && params.spawnedBy === "agent:main:main",
              ),
            ].every((request) => request !== undefined && responses.has(request.id)),
          )
          .toBe(true);
        await selected.waitFor();
        await expect.poll(() => lists.every((request) => responses.has(request.id))).toBe(true);
        expect(
          lists.some(
            ({ params }) => params.includeOwnerSessionCounts && params.excludeSubagents === true,
          ),
        ).toBe(false);
        await page.exposeFunction("recordRosterEvent", (label: string) => {
          labels.add(label);
        });
        await evaluateControlUiContext(page, (context) => {
          // Register after app consumers so receipt also proves their debounce was armed.
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
        const eventRenderMs = 20;
        // Await real delivery, not patch's ACK; only the browser clock is virtual.
        const patch = async (sessionKey: string, label: string) => {
          await emitter.request("sessions.patch", { key: sessionKey, label });
          await expect.poll(() => labels.has(label)).toBe(true);
          if (sessionKey === key) {
            await page.clock.runFor(eventRenderMs);
            await expect.poll(() => selected.textContent()).toContain(label);
          }
        };
        expect(lists.length).toBeGreaterThan(0);
        const before = [...lists];
        await page.clock.runFor(60_000);
        expect(lists).toEqual(before);
        await patch(key, "First rate update");
        await roster.getByText("First rate update", { exact: true }).waitFor();
        for (let index = 0; index < 3; index += 1) {
          await patch(key, "Trailing rate update " + index);
          await roster.getByText("Trailing rate update " + index, { exact: true }).waitFor();
          await page.clock.runFor(1_000);
        }
        await page.clock.runFor(56_999 - 4 * eventRenderMs);
        expect(lists).toEqual(before);
        await page.clock.runFor(5_001);
        expect(lists).toEqual(before);
        await roster.getByText("Trailing rate update 2", { exact: true }).waitFor();
        await expect.poll(() => selected.textContent()).toContain("Trailing rate update 2");
        // Counts belong to Online; opening it must still fetch them on demand.
        await page.clock.resume();
        await sidebar.locator('[data-navigation-view="online"]').click();
        await expect
          .poll(() =>
            lists.some(
              ({ params }) => params.includeOwnerSessionCounts && params.excludeSubagents === true,
            ),
          )
          .toBe(true);
        await expect.poll(() => lists.every((request) => responses.has(request.id))).toBe(true);
        await sidebar.locator('[data-navigation-view="sessions"]').click();
        await selected.waitFor();
        await expect.poll(() => lists.every((request) => responses.has(request.id))).toBe(true);
        await pauseVirtualClock(page);
        const beforeOther = lists.length;
        await patch(otherKey, "Unrelated rate update");
        await page.clock.runFor(15_000);
        // A changed row in another agent cannot invalidate this page's window.
        const afterOther = lists.slice(beforeOther);
        expect(afterOther).toEqual([]);
        // A relevant successor proves the quiet interval did not retire the subscription.
        await patch(key, "Relevant after unrelated");
        await page.clock.runFor(5_000);
        expect(lists.slice(beforeOther)).toEqual([]);
        await roster.getByText("Relevant after unrelated", { exact: true }).waitFor();
        await page.clock.resume();
        await chooseSidebarOwner(page, "owner:" + viewerId);
        await expect.poll(() => lists.every((request) => responses.has(request.id))).toBe(true);
        await selected.waitFor();
        await pauseVirtualClock(page);
        const beforeForeign = lists.length;
        for (let index = 0; index < 12; index++) {
          const label = "Other owner's update " + index;
          await patch(foreignKey, label);
          await page.clock.runFor(5_000);
          await roster.getByText(label, { exact: true }).waitFor();
        }
        const patchReads = lists
          .slice(beforeForeign)
          .filter(({ params }) => params.ownerId === viewerId);
        expect(await sidebar.locator(`[data-session-key="${foreignKey}"]`).count()).toBe(0);
        await page.clock.resume();
        const beforeRuns = lists.length;
        const runs = await Promise.all(
          [foreignKey, foreignKey + "-second"].map(async (sessionKey) => {
            const runId = randomUUID();
            await emitter.request("agent", {
              sessionKey,
              message: "Exercise the synthetic roster tools.",
              deliver: false,
              idempotencyKey: runId,
            });
            return runId;
          }),
        );
        await expect.poll(() => modelResponses.length).toBe(2);
        for (const index of [1, 2]) {
          await access(path.join(owner.state.workspaceDir, `roster-tool-${index}.txt`));
        }
        await expect
          .poll(() =>
            evaluateControlUiContext(
              page,
              (context) =>
                context.sessions.state.result?.sessions.filter((row) => row.hasActiveRun).length,
            ),
          )
          .toBe(2);
        await pauseVirtualClock(page);
        await page.clock.runFor(60_000);
        const activeReads = lists
          .slice(beforeRuns)
          .filter(({ params }) => params.ownerId === viewerId);
        console.info("roster-request-rate", {
          idleMinute: 0,
          otherOwnerPatchMinute: patchReads.length,
          concurrentActiveMinute: activeReads.length,
          mockTurns: runs.length,
          toolWrites: 2,
        });
        modelResponses.splice(0).forEach((response, index) =>
          writeOpenAiResponsesText(response, {
            text: "Synthetic roster answer",
            messageId: `roster-message-${index}`,
            responseId: `roster-response-${index}`,
          }),
        );
        await page.clock.resume();
        for (const runId of runs) {
          expect(await emitter.request("agent.wait", { runId, timeoutMs: 60_000 })).toMatchObject({
            status: "ok",
          });
        }
        await expect
          .poll(() =>
            evaluateControlUiContext(
              page,
              (context) =>
                context.sessions.state.result?.sessions.filter((row) => row.hasActiveRun).length,
            ),
          )
          .toBe(0);
        expect(patchReads).toEqual([]);
        expect(activeReads).toEqual([]);
        await emitter.request("sessions.assignOwner", {
          key: foreignKey,
          owner: { type: "human", id: viewerId },
        });
        await page.clock.resume();
        await sidebar.locator(`[data-session-key="${foreignKey}"]`).waitFor();
        expect(lists.slice(beforeForeign).some(({ params }) => params.ownerId === viewerId)).toBe(
          true,
        );
      });
    } finally {
      await disconnectGatewayClient(emitter);
    }
  });
});
