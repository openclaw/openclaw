import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../src/gateway/test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.listener.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { installMockGateway } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const token = "synthetic-catalog-mutation-token";
let state: OpenClawTestState | undefined;
let gatewayStartup: ReturnType<typeof startGatewayWithClient> | undefined;
let realGateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
const suite = createControlUiE2eSuite({
  name: "Control UI catalog bootstrap",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}`,
  resources: {
    retainedState: () => state?.root,
    async run(signal) {
      state = await createOpenClawTestState({
        label: "chat-catalog-mutation",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        },
      });
      signal.throwIfAborted();
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
      const portClaim = await acquireGatewayE2ePortBlock();
      if (signal.aborted) {
        // Gateway startup has not taken ownership of the claim yet.
        await portClaim.release();
        signal.throwIfAborted();
      }
      gatewayStartup = startGatewayWithClient({
        portClaim,
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
      realGateway = await gatewayStartup;
      // Startup cron hydration publishes a separate sessions.changed invalidation.
      await realGateway.server.startupSettled;
      signal.throwIfAborted();
    },
    async close() {
      const owner = await gatewayStartup;
      if (owner) {
        await runQaGatewayFixture(
          () => disconnectGatewayClient(owner.client),
          () => owner.server.close({ reason: "catalog mutation browser proof complete" }),
        );
      }
    },
    async release() {
      await state?.cleanup();
    },
  },
});
const requireRecord = createRequireRecord("record", "expected-object-value");

suite.define(() => {
  it.each([
    {
      route: "chat/alpha/~key/session-one",
      sessionKey: "agent:alpha:session-one",
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha",
      sessionKey: "agent:alpha:main",
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha/abcdef12",
      sessionKey: "agent:alpha:dm:abcdef1234567890abcdef1234567890",
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha",
      sessionKey: "global",
      sessionScope: "global" as const,
    },
  ])(
    "opens $route ($sessionKey) with one scoped catalog read",
    async ({ route, sessionKey, sessionScope }) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const current = {
        provider: "fixture",
        id: "session-current",
        name: "Session model",
        available: true,
      };
      const older = { ...current, id: "older", name: "Older model" };
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
        expect(connect.params).not.toHaveProperty("modelCatalog");
        await gateway.waitForRequest("models.list", { match: scope });
        await gateway.resolveDeferred("models.list", {
          models: [current],
          pendingProviders: ["fixture"],
          accountSelection: {
            kind: "personal",
            authProfileId: "personal:fixture-person:fixture:one",
            label: "Pinned session account",
            source: "user",
          },
        });
        const picker = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
        );
        const trigger = picker.locator("[data-chat-model-select]");
        const currentRow = picker.locator('[data-chat-model-option="fixture/session-current"]');
        await expect.poll(() => trigger.textContent()).toContain("Session model");
        // The chat pane starts its child roster after a deferred mount; settle that owner first.
        await expect
          .poll(() =>
            evaluateControlUiContext(
              page,
              ({ sessions }, key) => {
                const snapshot = sessions.listSnapshot({
                  spawnedBy: key,
                  limit: 10_000,
                  includeGlobal: false,
                  includeUnknown: false,
                  configuredAgentsOnly: true,
                });
                return snapshot.readSucceeded && !snapshot.loading;
              },
              sessionKey,
            ),
          )
          .toBe(true);
        const requestsBeforeOpen = (await gateway.getRequests("models.list")).length;
        expect(await gateway.getRequests("models.list", scope)).toHaveLength(1);
        const sessionRequestsBeforeOpen = (await gateway.getRequests("sessions.list")).length;
        await trigger.click();
        await revealChatModelOption(currentRow);
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await picker.textContent()).toContain("Pinned session account");
        expect(await picker.locator("[data-chat-model-refresh]").textContent()).toContain(
          "Refreshing models for Fixture…",
        );
        expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
        expect(await gateway.getRequests("models.list")).toHaveLength(requestsBeforeOpen);
        expect(await gateway.getRequests("sessions.list")).toHaveLength(sessionRequestsBeforeOpen);
        await trigger.click();
        await trigger.click();
        await revealChatModelOption(currentRow);
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await gateway.getRequests("models.list")).toHaveLength(requestsBeforeOpen);
        expect(await gateway.getRequests("sessions.list")).toHaveLength(sessionRequestsBeforeOpen);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("refreshes the pinned account through ordinary reads and reconnects without remounting", async () => {
    const { port, client: admin } = realGateway;
    const sessionKey = "agent:alpha:catalog-account-reconnect";
    await upsertSessionEntryCore(
      { agentId: "alpha", sessionKey },
      {
        sessionId: "catalog-account-reconnect",
        updatedAt: Date.now(),
        authProfileOverride: "fixture:account-a",
        authProfileOverrideSource: "user",
      },
    );
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const replacementSeen = createDeferred();
      const connected = createDeferred<() => Promise<void>>();
      const heldReplies: Array<() => void> = [];
      let holdReplacement = true;
      let catalogReads = 0;
      await page.routeWebSocket(`ws://127.0.0.1:${port}/**`, (socket) => {
        const server = socket.connectToServer();
        const requests = new Set<string>();
        connected.resolve(() => socket.close({ code: 1012, reason: "Reconnect proof" }));
        socket.onMessage((message) => {
          const frame = requireRecord(JSON.parse(message.toString()));
          if (frame.method === "models.list" && typeof frame.id === "string") {
            requests.add(frame.id);
            catalogReads += 1;
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = requireRecord(JSON.parse(message.toString()));
          if (
            holdReplacement &&
            frame.ok &&
            typeof frame.id === "string" &&
            requests.has(frame.id) &&
            requireRecord(requireRecord(frame.payload).accountSelection).authProfileId ===
              "fixture:account-b"
          ) {
            heldReplies.push(() => socket.send(message));
            replacementSeen.resolve();
            return;
          }
          socket.send(message);
        });
      });
      const url = new URL("chat/alpha/~key/catalog-account-reconnect", suite.server.baseUrl);
      url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
      url.hash = `token=${token}`;
      await page.goto(url.href);
      await page
        .locator("openclaw-gateway-url-confirmation")
        .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
        .click();
      const picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      const trigger = picker.locator('[data-chat-model-select][aria-disabled="false"]');
      const account = picker.locator("[data-chat-account-group-toggle]");
      await trigger.click();
      await expect.poll(() => account.textContent()).toContain("Account A");
      await admin.request("sessions.patch", {
        key: sessionKey,
        agentId: "alpha",
        model: "fixture/second@fixture:account-b",
      });
      await withTestTimeout(replacementSeen.promise, 10_000, "Account B read did not arrive");
      holdReplacement = false;
      heldReplies.splice(0).forEach((send) => send());
      await expect.poll(() => account.textContent()).toContain("Account B");
      const shell = await page.locator("openclaw-app-shell").elementHandle();
      if (!shell) {
        throw new Error("App shell not mounted");
      }
      await trigger.click();
      const readsBeforeReconnect = catalogReads;
      await (
        await connected.promise
      )();
      await expect.poll(() => catalogReads).toBeGreaterThan(readsBeforeReconnect);
      await trigger.click();
      await expect.poll(() => account.textContent()).toContain("Account B");
      expect(await shell.evaluate((element) => element.isConnected)).toBe(true);
      const row = picker.locator('[data-chat-model-option="fixture/second"]');
      await revealChatModelOption(row);
      await expect.poll(() => row.isVisible()).toBe(true);
      expect(await row.isEnabled()).toBe(true);
      const readsBeforeOpen = catalogReads;
      await trigger.click();
      await trigger.click();
      await expect.poll(() => account.textContent()).toContain("Account B");
      expect(catalogReads).toBe(readsBeforeOpen);
    });
  }, 60_000);
});
