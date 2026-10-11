import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
  startControlUiE2eServer,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    readCoalescingWire: { pending: Map<string, MockGatewayRequest>; duplicates: string[] };
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI chat session read coalescing",
  startServer: () => startControlUiE2eServer(),
});

suite.define(() => {
  it("paces incomplete ancestry and validates metadata against the pending catalog", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "desktop.observe",
          "browser.request",
          "board.get",
          "controlUi.sessionPullRequests.subscribe",
          "sessions.github.publish",
        ],
        methodResponses: {
          "question.list": { questions: [] },
          "environments.list": { environments: [] },
          "board.get": { revision: 1, tabs: [], widgets: [] },
          "sessions.github.options": {
            shared: null,
            personal: null,
            pendingPersonal: null,
            latestShared: null,
          },
          "controlUi.sessionPullRequests.subscribe": { ok: true },
        },
        sessionKey: "agent:main:main",
        sessions: [],
        historyMessages: [],
        agentModel: "fixture/echo",
        models: [{ id: "echo", name: "Echo", provider: "fixture", contextWindow: 128_000 }],
      });
      await page.addInitScript(() => {
        const wire = (window.readCoalescingWire = {
          pending: new Map<string, MockGatewayRequest>(),
          duplicates: [] as string[],
        });
        const methods = new Set(["sessions.describe", "sessions.branches.list", "models.list"]);
        const signature = ({ method, params }: MockGatewayRequest) =>
          JSON.stringify([
            method,
            Object.entries(params ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
          ]);
        const instrument = (Base: typeof WebSocket) =>
          class extends Base {
            override send(data: Parameters<WebSocket["send"]>[0]) {
              if (typeof data === "string") {
                const frame = JSON.parse(data) as MockGatewayRequest & { type: string };
                if (frame.type === "req") {
                  const key = signature(frame);
                  if (
                    methods.has(frame.method) &&
                    [...wire.pending.values()].some((other) => signature(other) === key)
                  ) {
                    wire.duplicates.push(key);
                  }
                  wire.pending.set(frame.id, frame);
                }
              }
              return super.send(data);
            }
            override dispatchEvent(event: Event) {
              if (event instanceof MessageEvent) {
                const frame = JSON.parse(String(event.data)) as { type: string; id: string };
                if (frame.type === "res") {
                  wire.pending.delete(frame.id);
                }
              }
              return super.dispatchEvent(event);
            }
          };
        // Init-script order is unspecified; instrument the mock's replacement too.
        let socket = instrument(window.WebSocket);
        Object.defineProperty(window, "WebSocket", {
          configurable: true,
          get: () => socket,
          set: (next: typeof WebSocket) => {
            socket = instrument(next);
          },
        });
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.clock.install();
      await pauseVirtualClock(page);
      await page.evaluate(() => {
        Math.random = () => 0;
      });
      const count = async (method: string, match?: Record<string, unknown>) =>
        (await gateway.getRequests(method, match)).length;
      const settle = async (heldMethod?: string) => {
        await expect
          .poll(async () => {
            await page.clock.runFor(1);
            return page.evaluate(
              (held) =>
                [...window.readCoalescingWire.pending.values()]
                  .filter(({ method }) => method !== held)
                  .map(({ method }) => method),
              heldMethod,
            );
          })
          .toEqual([]);
      };
      await gateway.deferNext("sessions.create");
      const composer = page.locator(".new-session-page__message");
      await composer.fill("Say a short hello.");
      await composer.press("Enter");
      const { params } = await gateway.waitForRequest("sessions.create");
      const { key } = params as { key: string };
      const runId = "fixture-run";
      await gateway.resolveDeferred("sessions.create", {
        ok: true,
        key,
        sessionId: "fixture-session",
        runId,
        runStarted: true,
        status: "started",
        entry: {
          kind: "direct",
          parentSessionKey: "agent:main:main",
          model: "echo",
          modelProvider: "fixture",
          updatedAt: await page.evaluate(() => Date.now()),
          activeRunIds: [runId],
          lastRunId: runId,
        },
      });
      // The swarm owner connects after 250 ms; its initial read must settle too.
      await expect
        .poll(async () => {
          await page.clock.runFor(20);
          return count("sessions.list", { spawnedBy: key });
        })
        .toBeGreaterThan(0);
      await settle();
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      expect(await count("board.get")).toBeGreaterThan(0);
      expect(await count("sessions.branches.list", { sessionKey: key })).toBeGreaterThan(0);
      expect(await count("sessions.describe", { key: "agent:main:main" })).toBeGreaterThan(0);
      const describes = () => count("sessions.describe", { key });
      const before = await describes();
      expect(before).toBeGreaterThan(0);
      let row = await gateway.getSessionRow(key);
      const messages: unknown[] = [];
      const emit = async (event: string, extra: Record<string, unknown>) => {
        const now = await page.evaluate(() => Date.now());
        row = { ...row, snapshotAt: now, updatedAt: now };
        await gateway.setSessionsListResponse({
          sessions: [row],
          count: 1,
          totalCount: 1,
          ts: now,
        });
        await gateway.setHistoryMessages(messages);
        await gateway.emitGatewayEvent(event, {
          sessionKey: key,
          agentId: "main",
          sessionId: row.sessionId,
          runId,
          ts: now,
          ...(event === "sessions.changed" || event === "session.message"
            ? { ...row, session: row }
            : {}),
          ...extra,
        });
        await settle();
        row = await gateway.getSessionRow(key);
      };
      const changed = (reason?: string, phase?: string) =>
        emit("sessions.changed", { ...(reason ? { reason } : {}), ...(phase ? { phase } : {}) });
      const message = (role: string, seq: number, text: string) => ({
        role,
        content: [{ type: "text", text }],
        __openclaw: { id: `fixture-${seq}`, seq },
      });
      const user = message("user", 1, "Say a short hello.");
      const assistant = message("assistant", 2, "Hello from the fixture.");
      // Replay the captured ordering without patch invalidations that absorb certification.
      // The missing parent deliberately leaves ancestorSessions absent on every event.
      const burstStarted = await page.evaluate(() => Date.now());
      await changed("send");
      messages.push(user);
      await emit("session.message", {
        message: user,
        messageId: "fixture-1",
        messageSeq: 1,
        senderIsOwner: true,
      });
      await changed("participants");
      await changed("send");
      await emit("agent", { stream: "lifecycle", seq: 3, data: { phase: "start" } });
      await changed(undefined, "start");
      await changed("agent.run.started");
      await changed(undefined, "model");
      await emit("chat", { seq: 6, state: "delta", message: assistant });
      messages.push(assistant);
      await emit("session.message", { message: assistant, messageId: "fixture-2", messageSeq: 2 });
      await changed(undefined, "model");
      row = { ...row, hasActiveRun: false, activeRunIds: [], status: "done" };
      await emit("agent", { stream: "lifecycle", seq: 10, data: { phase: "end" } });
      await emit("chat", { seq: 10, state: "final", message: assistant });
      await changed("agent.input.settled");
      await changed(undefined, "end");
      await page.getByText("Hello from the fixture.", { exact: true }).first().waitFor();
      expect.soft(await describes(), "no per-event descriptors").toBe(before);
      await page.clock.runFor(4_999 - ((await page.evaluate(() => Date.now())) - burstStarted));
      expect.soft(await describes(), "no descriptor before collection expires").toBe(before);
      await page.clock.runFor(1);
      expect.soft(await describes(), "one shared authoritative descriptor").toBe(before + 1);
      await settle();

      const scope = { sessionKey: key };
      const modelsBefore = await count("models.list", scope);
      const metadataScope = { agentId: "main", includeModels: false };
      const metadataBefore = await count("chat.metadata", metadataScope);
      await gateway.deferNext("models.list", scope);
      await changed("patch");
      await page.clock.runFor(2_500);
      await settle("models.list");
      // The startup fixture omitted commands; acquire them beside the pending catalog once.
      expect(await count("chat.metadata", metadataScope)).toBe(metadataBefore + 1);
      expect(await count("models.list", scope)).toBe(modelsBefore + 1);
      await gateway.resolveDeferred("models.list");
      await settle();
      expect
        .soft(await count("models.list", scope), "no replacement catalog read")
        .toBe(modelsBefore + 1);
      expect.soft(await describes(), "bounded total descriptors").toBeLessThanOrEqual(8);
      expect(await page.evaluate(() => window.readCoalescingWire.duplicates)).toEqual([]);
    });
  });
});
