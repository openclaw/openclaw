import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../src/config/config.ts";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
  withTranscriptWriteSequence,
} from "../../../src/config/sessions/session-accessor.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.ts";
import { linkUserChannelIdentity } from "../../../src/state/user-channel-identities.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Slack inline identity display",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:slack-inline-identity-proof";
const authenticatedUser = "slack-proof-patrick@example.test";
const source =
  "<@U1111111111> (Slack Alice), ask <@U2222222222> (Roboclaw) to open a PR. Unknown: <@U3333333333>. Code: `<@U1111111111>`.";

suite.define(() => {
  it("renders linked people and bot fallbacks through a real Gateway without rewriting code", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "slack-inline-identity",
      env: {
        ...deviceGatewayEnv,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
    });
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    await runQaGatewayFixture(
      async () => {
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [authenticatedUser],
          requiredHeaders: ["x-forwarded-for"],
          userHeader: "x-forwarded-user",
          deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
        };
        await state.writeConfig({
          plugins: { entries: { slack: { enabled: true } } },
          channels: { slack: { enabled: false } },
          agents: { entries: { main: { name: "Main", workspace: state.workspaceDir } } },
          gateway: {
            auth: { mode: "trusted-proxy", trustedProxy },
            trustedProxies: ["127.0.0.1"],
            controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin] },
          },
        });
        await captureRuntimeConfigAsyncReader()();
        // Synthetic identities are seeded before this task-owned Gateway starts.
        const sender = ensureProfileForEmail(authenticatedUser);
        const person = ensureProfileForEmail("slack-proof-alice@example.test");
        setDisplayName(sender.id, "Patrick Erichsen");
        setDisplayName(person.id, "Gateway Alice");
        setUserProfileRole(sender.id, "administrator");
        setUserProfileRole(person.id, "administrator");
        linkUserChannelIdentity(person.id, {
          channelId: "slack",
          accountId: "work",
          senderId: "u1111111111",
        });
        const scope = {
          agentId: "main",
          sessionKey,
          sessionId: "slack-inline-proof",
          env: state.env,
        };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          visibility: "shared",
          displayName: "Slack mention proof — synthetic fixture",
          createdActor: { type: "human", source: "profile", id: sender.id },
        });
        await appendTranscriptMessage(scope, {
          eventId: "slack-inline-proof-message",
          message: {
            role: "user",
            content: [{ type: "text", text: source }],
            timestamp: Date.now(),
            __openclaw: {
              senderIdentity: { type: "profile", id: sender.id },
              senderName: "Patrick Erichsen",
              requesterOrigin: {
                sessionKey,
                messageProvider: "slack",
                accountId: "work",
                senderId: "u9999999999",
              },
              transport: { channel: "slack", messageId: "1793736900.000001" },
            },
          },
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        proxy = await createGatewayProxy(state.workspaceDir, {
          "/": gatewayProxyRoute(port, authenticatedUser),
        });
        await proxy.listen();
        const gatewayUrl = new URL(
          expectDefined(proxy.resolvedUrls?.local[0], "Slack proof proxy URL"),
        );
        gatewayUrl.protocol = "ws:";
        // Warm the real history projection before the browser assertion deadline.
        const historyClient = await connectGatewayClient({
          url: gatewayUrl.href,
          origin: new URL(suite.server.baseUrl).origin,
          clientName: "openclaw-control-ui",
          mode: "ui",
          scopes: ["operator.read"],
        });
        try {
          await historyClient.request("chat.history", { sessionKey, limit: 1 });
        } finally {
          await disconnectGatewayClient(historyClient);
        }
        await suite.withPage(
          { viewport: { width: 1440, height: 1000 }, locale: "en-US" },
          async ({ page }) => {
            const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
            await page.goto(url.href);
            await page
              .locator("openclaw-gateway-url-confirmation")
              .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            const transcript = page.locator(".chat-thread-inner");
            await expect
              .poll(() => transcript.textContent(), { timeout: 30_000 })
              .toContain("open a PR");
            const capture = process.env.OPENCLAW_SLACK_IDENTITY_CAPTURE;
            if (capture) {
              await mkdir(path.dirname(capture), { recursive: true });
              await transcript.screenshot({ path: capture });
            }
            expect(await transcript.textContent()).toContain("@Gateway Alice, ask @Roboclaw");
            expect(await transcript.textContent()).toContain("<@U3333333333>");
            expect(await transcript.locator("code").textContent()).toBe("<@U1111111111>");
            await withTranscriptWriteSequence(scope, async (transcriptWriter) => {
              const committed = await transcriptWriter.appendMessageWithMessageSequence({
                eventId: "slack-inline-live-message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "Live: " + source }],
                  timestamp: Date.now(),
                  __openclaw: {
                    senderIdentity: { type: "profile", id: sender.id },
                    senderName: "Patrick Erichsen",
                    requesterOrigin: {
                      sessionKey,
                      messageProvider: "slack",
                      accountId: "work",
                      senderId: "u9999999999",
                    },
                    transport: { channel: "slack", messageId: "1793736901.000001" },
                  },
                },
              });
              const row = expectDefined(committed.result, "committed live fixture message");
              expect(row.appended).toBe(true);
              await transcriptWriter.publishUpdate({
                message: row.message,
                messageId: row.messageId,
                messageSeq: committed.messageSeq,
                lifecycleRevision: committed.lifecycleRevision,
              });
            });
            await expect
              .poll(() => transcript.textContent(), { timeout: 30_000 })
              .toContain("Live: @Gateway Alice, ask @Roboclaw");
          },
        );
      },
      () => proxy?.close(),
      () => gateway?.close({ reason: "Slack identity proof cleanup" }),
      () => state.cleanup(),
    );
  });
});
