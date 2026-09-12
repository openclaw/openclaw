import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "../../../src/gateway/test-helpers.e2e.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const requireRecord = createRequireRecord("record", "expected-object-value");

suite.define(() => {
  it.each([
    {
      route: "chat/alpha/~key/session-one",
      sessionKey: "agent:alpha:session-one",
      target: { agentId: "alpha", sessionKey: "agent:alpha:session-one" },
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha",
      sessionKey: "agent:alpha:main",
      target: { agentId: "alpha", sessionKey: "agent:alpha:main" },
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha/abcdef12",
      sessionKey: "agent:alpha:dm:abcdef1234567890abcdef1234567890",
      target: { agentId: "alpha", shortId: "abcdef12" },
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha",
      sessionKey: "global",
      target: { agentId: "alpha", sessionKey: "agent:alpha:main" },
      sessionScope: "global" as const,
    },
  ])(
    "opens $route ($sessionKey) from its session snapshot while an older reply is held",
    async ({ route, sessionKey, target, sessionScope }) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const current = {
        provider: "fixture",
        id: "session-current",
        name: "Session model",
        available: true,
      };
      const older = { ...current, id: "older", name: "Older model" };
      const foreign = { ...current, id: "foreign", name: "Another context's model" };
      const scope = { agentId: "alpha", sessionKey };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "alpha",
        sessionKey,
        sessionScope,
        mainSessionKey: sessionScope === "global" ? "global" : "agent:alpha:main",
        agentModel: "fixture/session-current",
        sessionInfo: { model: current.id, modelProvider: current.provider },
        models: [older],
        heldMethods: ["models.list"],
        presenceUsers: [{ id: "fixture-person", name: "Fixture Person", self: true }],
        methodResponses: {
          "sessions.list": {
            ts: 1,
            path: "",
            count: 1,
            sessions: [
              {
                key: sessionKey,
                sessionId: "fixture-session",
                kind: "direct",
                updatedAt: 1,
                model: current.id,
                modelProvider: current.provider,
              },
            ],
            defaults: { model: current.id, modelProvider: current.provider, contextTokens: null },
          },
          "models.list": {
            models: [older],
            accountSelection: { kind: "automatic", label: "Automatic" },
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}${route}`);
        const connect = await gateway.waitForRequest("connect");
        expect(connect.params).toMatchObject({ modelCatalog: target });
        await expect
          .poll(async () => (await gateway.getRequests("models.list", scope)).length)
          .toBe(1);
        // The chat's delayed child roster request is startup work, independent of the picker.
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
        for (const otherScope of [
          { agentId: "alpha" },
          { agentId: "alpha", sessionKey: "agent:alpha:other" },
          { agentId: "bravo", sessionKey: "agent:bravo:session-one" },
        ]) {
          await gateway.emitGatewayEvent("models.snapshot", {
            target: otherScope,
            scope: otherScope,
            catalog: { models: [foreign] },
          });
        }
        expect(await gateway.getRequests("models.list", scope)).toHaveLength(1);
        await gateway.emitGatewayEvent("models.snapshot", {
          target,
          scope: "shortId" in target ? scope : target,
          catalog: {
            models: [current],
            pendingProviders: ["fixture"],
            accountSelection: {
              kind: "personal",
              authProfileId: "personal:fixture-person:fixture:one",
              label: "Pinned session account",
              source: "user",
            },
          },
        });
        const picker = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
        );
        const trigger = picker.locator("[data-chat-model-select]");
        const currentRow = picker.locator('[data-chat-model-option="fixture/session-current"]');
        const requestsBeforeOpen = (await gateway.getRequests("models.list")).length;
        const sessionRequestsBeforeOpen = (await gateway.getRequests("sessions.list")).length;
        await trigger.click();
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await picker.textContent()).toContain("Pinned session account");
        expect(await picker.locator("[data-chat-model-catalog-state]").textContent()).toContain(
          "fixture",
        );
        expect(await gateway.getRequests("models.list")).toHaveLength(requestsBeforeOpen);
        expect(await gateway.getRequests("sessions.list")).toHaveLength(sessionRequestsBeforeOpen);
        await gateway.resolveDeferred("models.list", { models: [older] });
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(
          await picker
            .locator(
              '[data-chat-model-option="fixture/older"], [data-chat-model-option="fixture/foreign"]',
            )
            .count(),
        ).toBe(0);
        expect(await picker.textContent()).toContain("Pinned session account");
        await trigger.click();
        await trigger.click();
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await gateway.getRequests("models.list")).toHaveLength(requestsBeforeOpen);
        expect(await gateway.getRequests("sessions.list")).toHaveLength(sessionRequestsBeforeOpen);
      } finally {
        await context.close();
      }
    },
  );

  it.each(["pending", "complete", "reconnect", "ordinary-reconnect"] as const)(
    "real chat route preserves account state during %s snapshot ordering",
    async (replacementState) => {
      const state = await createOpenClawTestState({
        label: `chat-catalog-mutation-${replacementState}`,
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        },
      });
      const port = await getGatewayE2ePortBlock();
      const token = "synthetic-catalog-mutation-token";
      const sessionKey = "agent:alpha:session-mutation";
      const frames: unknown[] = [];
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        state.applyEnv();
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              "fixture:account-a": {
                type: "api_key",
                provider: "fixture",
                key: "synthetic-a",
                displayName: "Account A",
              },
              "fixture:account-b": {
                type: "api_key",
                provider: "fixture",
                key: "synthetic-b",
                displayName: "Account B",
              },
            },
          },
          "alpha",
        );
        gateway = await startGatewayWithClient({
          port,
          configPath: state.configPath,
          token,
          scopes: ["operator.admin"],
          cfg: {
            gateway: {
              mode: "local",
              auth: { mode: "token", token },
              controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin] },
            },
            plugins: { enabled: false },
            agents: {
              ownership: "explicit",
              entries: {
                alpha: {
                  workspace: state.workspaceDir,
                  model: "fixture/first",
                  modelPolicy: { allow: ["fixture/first", "fixture/second"] },
                },
              },
            },
            models: {
              catalogRefresh: { enabled: false },
              providers: {
                fixture: {
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:9/v1",
                  apiKey: "synthetic-provider-key",
                  models: [
                    { id: "first", name: "First model" },
                    { id: "second", name: "Second model" },
                  ],
                },
              },
            },
          },
        });
        const admin = gateway.client;
        await upsertSessionEntryCore(
          { agentId: "alpha", sessionKey },
          {
            sessionId: "catalog-mutation-session",
            updatedAt: Date.now(),
            authProfileOverride: "fixture:account-a",
            authProfileOverrideSource: "user",
          },
        );
        await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
          let initialSnapshot = createDeferred<{ deliver: () => void; payload: unknown }>();
          const disconnect = createDeferred<() => Promise<void>>();
          const replacementRead = createDeferred();
          const invalidation = createDeferred();
          const catalogRequests = new Set<string>();
          const heldReplies: Array<() => void> = [];
          let holdReplacement = true;
          let holdReconnectCatalog = false;
          await page.routeWebSocket(`ws://127.0.0.1:${port}/**`, (socket) => {
            const server = socket.connectToServer();
            disconnect.resolve(() => socket.close({ code: 1012, reason: "Reconnect proof" }));
            socket.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (
                frame.type === "req" &&
                frame.method === "models.list" &&
                typeof frame.id === "string" &&
                requireRecord(frame.params).sessionKey === sessionKey
              ) {
                catalogRequests.add(frame.id);
                frames.push({ direction: "request", frame });
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (frame.event === "models.snapshot") {
                frames.push({ direction: "held-initial", frame });
                initialSnapshot.resolve({
                  deliver: () => socket.send(message),
                  payload: frame.payload,
                });
                return;
              }
              if (frame.event === "sessions.changed") {
                frames.push({ direction: "invalidation", frame });
                const payload = requireRecord(frame.payload);
                if (payload.sessionKey === sessionKey && payload.reason === "patch") {
                  invalidation.resolve();
                }
              }
              if (typeof frame.id === "string" && catalogRequests.has(frame.id)) {
                frames.push({ direction: "response", frame });
                if (holdReconnectCatalog) {
                  heldReplies.push(() => socket.send(message));
                  return;
                }
                if (
                  frame.ok &&
                  requireRecord(requireRecord(frame.payload).accountSelection).authProfileId ===
                    "fixture:account-b"
                ) {
                  replacementRead.resolve();
                  if (holdReplacement) {
                    heldReplies.push(() => socket.send(message));
                    return;
                  }
                }
              }
              socket.send(message);
            });
          });
          const url = new URL("chat/alpha/~key/session-mutation", suite.server.baseUrl);
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          url.hash = `token=${token}`;
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
            .click();
          const initial = await withTestTimeout(
            initialSnapshot.promise,
            10_000,
            "Initial account A snapshot did not arrive",
          );
          expect(
            requireRecord(requireRecord(initial.payload).catalog).accountSelection,
          ).toMatchObject({
            authProfileId: "fixture:account-a",
          });
          const picker = page.locator(
            'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
          );
          const trigger = picker.locator('[data-chat-model-select][aria-disabled="false"]');
          const account = picker.locator("[data-chat-account-group-toggle]");
          await trigger.click();
          await expect.poll(() => account.isVisible()).toBe(true);
          await expect.poll(() => account.textContent()).toContain("Account A");
          if (replacementState === "reconnect" || replacementState === "ordinary-reconnect") {
            const mountedShell = await page.locator("openclaw-app-shell").elementHandle();
            assert.ok(mountedShell);
            await trigger.click();
            initialSnapshot = createDeferred<{ deliver: () => void; payload: unknown }>();
            holdReconnectCatalog = true;
            frames.push({ direction: "disconnect-mounted-shell" });
            await (
              await disconnect.promise
            )();
            const reconnected = await withTestTimeout(
              initialSnapshot.promise,
              10_000,
              "Reconnected catalog snapshot did not arrive",
            );
            await expect.poll(() => heldReplies.length).toBeGreaterThan(0);
            expect(await mountedShell.evaluate((element) => element.isConnected)).toBe(true);
            if (replacementState === "reconnect") {
              frames.push({ direction: "deliver-reconnect-snapshot" });
              reconnected.deliver();
            } else {
              frames.push({ direction: "deliver-ordinary-without-snapshot" });
              holdReconnectCatalog = false;
              heldReplies.splice(0).forEach((send) => send());
            }
            const requestsBeforeOpen = catalogRequests.size;
            await trigger.click();
            await expect.poll(() => account.isVisible()).toBe(true);
            await expect.poll(() => account.textContent()).toContain("Account A");
            const row = picker.locator('[data-chat-model-option="fixture/first"]');
            await expect.poll(() => row.isVisible()).toBe(true);
            expect(await row.isEnabled()).toBe(true);
            expect(catalogRequests.size).toBe(requestsBeforeOpen);
            await page.screenshot({
              path: path.join(suite.artifactDir, `catalog-${replacementState}.png`),
            });
            holdReconnectCatalog = false;
            heldReplies.splice(0).forEach((send) => send());
            await trigger.click();
            await trigger.click();
            await expect.poll(() => row.isVisible()).toBe(true);
            expect(catalogRequests.size).toBe(requestsBeforeOpen);
            return;
          }
          frames.push({ direction: "patch", model: "fixture/second@fixture:account-b" });
          await admin.request("sessions.patch", {
            key: sessionKey,
            agentId: "alpha",
            model: "fixture/second@fixture:account-b",
          });
          await withTestTimeout(
            invalidation.promise,
            10_000,
            "The registered session patch did not invalidate the browser",
          );
          await withTestTimeout(
            replacementRead.promise,
            10_000,
            "Account B replacement catalog did not arrive",
          );
          const deliverReplacement = () => {
            holdReplacement = false;
            heldReplies.splice(0).forEach((send) => send());
          };
          if (replacementState === "complete") {
            deliverReplacement();
            await expect.poll(() => account.textContent()).toContain("Account B");
          }
          frames.push({ direction: "deliver-initial", replacementState });
          initial.deliver();
          // Cross one browser render before releasing B so the stale snapshot can cancel it.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
              }),
          );
          if (replacementState === "pending") {
            deliverReplacement();
          }
          await expect.poll(() => account.textContent()).toContain("Account B");
          const selectedRow = picker.locator('[data-chat-model-option="fixture/second"]');
          await expect.poll(() => selectedRow.isVisible()).toBe(true);
          expect(await selectedRow.isEnabled()).toBe(true);
          expect(await account.textContent()).not.toContain("Account A");
          const readsBeforeReopen = catalogRequests.size;
          await trigger.click();
          await trigger.click();
          await expect.poll(() => account.textContent()).toContain("Account B");
          expect(await selectedRow.isEnabled()).toBe(true);
          expect(catalogRequests.size).toBe(readsBeforeReopen);
        });
      } finally {
        await writeFile(
          path.join(suite.artifactDir, `catalog-mutation-${replacementState}.json`),
          JSON.stringify(frames, null, 2),
        );
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "catalog mutation browser proof complete" });
        }
        await state.cleanup();
      }
    },
    60_000,
  );
});
