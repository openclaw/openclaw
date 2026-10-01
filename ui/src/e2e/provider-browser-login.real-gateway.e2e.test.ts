import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { racePromiseWithAbortSignal } from "../../../src/infra/abort-signal.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ModelAuthStatusResult, ModelCatalogResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  loginHistoryMarker,
  loginOrigin,
  loginSessionKey,
  type ProviderBrowserLoginOptions,
  loginProvider,
  startProviderBrowserLoginFixture,
} from "./provider-browser-login.test-support.ts";

let fixture: Awaited<ReturnType<typeof startProviderBrowserLoginFixture>>;
let readback: { client: GatewayClient; nextPublication: () => Promise<void> };
async function connectReadbackClient() {
  let publication = createDeferred();
  const client = await acquireGatewayTestClient(
    {
      url: fixture.instance.url,
      token: fixture.instance.gatewayToken,
      env: fixture.instance.env,
      clientName: "cli",
      mode: "cli",
      scopes: ["operator.read", "operator.write"],
      deviceIdentity: null,
      deviceAuthScope: fixture.instance.url,
      sharedStateMode: "read-only",
      requestTimeoutMs: 10_000,
      onEvent: ({ event }) => {
        if (event === "chat.metadata.changed") {
          publication.resolve();
          publication = createDeferred();
        }
      },
    },
    {
      timeoutMs: 10_000,
      timeoutMessage: "Browser login readback client did not connect",
      closeMessage: "Browser login readback client closed during connect",
    },
  );
  return { client, nextPublication: () => publication.promise };
}
const browserArgs: string[] = [];
const suite = createControlUiE2eSuite({
  name: "Provider browser login through real HTTPS Gateway",
  startServerBeforeBrowser: true,
  browserLaunchOptions: { args: browserArgs },
  async startServer() {
    const optionsPath = process.env.OPENCLAW_UI_E2E_PROVIDER_LOGIN_OPTIONS;
    const options: ProviderBrowserLoginOptions = optionsPath
      ? (await import(pathToFileURL(optionsPath).href)).default
      : {};
    fixture = await startProviderBrowserLoginFixture(options);
    try {
      readback = await connectReadbackClient();
    } catch (error) {
      return await runQaGatewayFixture(
        async (): Promise<never> => {
          throw error;
        },
        () => fixture.close(),
      );
    }
    browserArgs.push(
      `--host-resolver-rules=MAP files.proxy.test:443 127.0.0.1:${fixture.edgePort}`,
      "--no-proxy-server",
    );
    return {
      baseUrl: fixture.baseUrl,
      close: () =>
        runQaGatewayFixture(
          () => fs.writeFile(path.join(suite.artifactDir, "gateway.log"), fixture.instance.logs()),
          () => readback.client.stopAndWait(),
          () => fixture.close(),
        ),
    };
  },
});

suite.define(() => {
  it("rejects cancelled and stale callbacks, then saves a fresh sign-in and serves an existing session", async () => {
    const call = <T = unknown>(method: string, params: Record<string, unknown>) =>
      readback.client.request<T>(method, params);
    const profile = async () => {
      const status: ModelAuthStatusResult = await call("models.authStatus", { agentId: "main" });
      return status.providers
        .flatMap((provider) => provider.profiles)
        .find((entry) => entry.profileId === `${loginProvider}:default`);
    };
    const initialAuthStatus: ModelAuthStatusResult = await call("models.authStatus", {
      agentId: "main",
    });
    await fs.writeFile(
      path.join(suite.artifactDir, "initial-auth-status.json"),
      JSON.stringify(initialAuthStatus, null, 2),
    );
    expect(
      initialAuthStatus.providerCapabilities?.flatMap((provider) => provider.loginOptions ?? []),
    ).toEqual([
      expect.objectContaining({
        id: `${loginProvider}/browser`,
        label: "Fixture browser sign-in",
        kind: "oauth",
      }),
    ]);
    const callbacks: Array<{ url: string; status: number }> = [];
    let finalHistory: unknown;
    const sessionKey = loginSessionKey;
    expect(JSON.stringify(await call("chat.history", { sessionKey }))).toContain(
      loginHistoryMarker,
    );
    const url = new URL("settings/model-providers", `${loginOrigin}/`);
    await suite.withPage(
      {
        ignoreHTTPSErrors: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page, context }) => {
        let pagePreviewRequests = 0;
        page.on("websocket", (socket) =>
          socket.on("framesent", (frame) => {
            const request: unknown = JSON.parse(String(frame.payload));
            if (isRecord(request) && request.method === "controlUi.linkPreview") {
              pagePreviewRequests++;
            }
          }),
        );
        await page.goto(url.href);
        expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
        await page
          .getByLabel("Gateway secret", { exact: true })
          .fill(fixture.instance.gatewayToken);
        await page.locator(".login-gate__connect").click();
        await page.locator('[data-kind="pairing-required"]').waitFor();
        const devices = await fixture.instance.cli(["devices", "list", "--json"]);
        expect(devices.code, devices.stderr).toBe(0);
        const pending = JSON.parse(devices.stdout).pending;
        expect(pending).toHaveLength(1);
        const approved = await fixture.instance.cli(["devices", "approve", pending[0].requestId]);
        expect(approved.code, approved.stderr).toBe(0);
        await waitForControlUiGatewayReady(page);
        const begin = async () => {
          await page.locator("[data-models-connect]").click();
          await page.locator(`[data-models-login-provider="${loginProvider}"]`).click();
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Fixture browser sign-in", exact: true })
            .click();
          const link = page.locator(".wizard-step__external-link");
          await link.waitFor();
          const popup = context.waitForEvent("page");
          await link.click();
          const providerPage = await popup;
          await providerPage.getByRole("heading", { name: "Authorize fixture account" }).waitFor();
          return providerPage;
        };
        const cancelledPage = await begin();
        await page.screenshot({ path: path.join(suite.artifactDir, "login-started.png") });
        expect(pagePreviewRequests).toBe(0);
        expect(await page.locator(".link-hovercard").count()).toBe(0);
        await page
          .locator("openclaw-modal-dialog")
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
        const cancelledCallback = cancelledPage.waitForResponse(
          (response) => new URL(response.url()).pathname === "/oauth/provider/callback",
        );
        await cancelledPage.getByRole("button", { name: "Approve sign-in" }).click();
        const cancelledResponse = await cancelledCallback;
        callbacks.push({ url: cancelledResponse.url(), status: cancelledResponse.status() });
        expect(cancelledResponse.status()).toBe(410);
        expect(await profile()).toBeUndefined();
        expect(fixture.requests).not.toContain("/token");
        await cancelledPage.waitForURL(cancelledResponse.url());
        const staleUrl = cancelledResponse.url();
        expect(new URL(staleUrl).origin).toBe(loginOrigin);
        const freshPage = await begin();
        const replay = expectDefined(await cancelledPage.goto(staleUrl), "callback response");
        callbacks.push({ url: replay.url(), status: replay.status() });
        expect(replay.status()).toBe(410);
        expect(await profile()).toBeUndefined();
        expect(fixture.requests).not.toContain("/token");
        const freshCallback = freshPage.waitForResponse(
          (response) => new URL(response.url()).pathname === "/oauth/provider/callback",
        );
        await freshPage.getByRole("button", { name: "Approve sign-in" }).click();
        const freshResponse = await freshCallback;
        callbacks.push({ url: freshResponse.url(), status: freshResponse.status() });
        expect(freshResponse.status()).toBe(200);
        await freshPage.waitForURL(freshResponse.url());
        expect(new URL(freshResponse.url()).origin).toBe(loginOrigin);
        await expect
          .poll(profile)
          .toMatchObject({ type: "api_key", profileId: `${loginProvider}:default` });
        await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
        await page
          .getByText("Fixture browser sign-in: Provider credentials saved.", { exact: true })
          .waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "login-completed.png") });
        await readback.client.stopAndWait();
        await fixture.instance.stopGateway();
        await fixture.instance.startGateway();
        readback = await connectReadbackClient();
        await waitForControlUiGatewayReady(page);
        expect(await profile()).toMatchObject({
          type: "api_key",
          profileId: `${loginProvider}:default`,
        });
        expect(JSON.stringify(await call("chat.history", { sessionKey }))).toContain(
          loginHistoryMarker,
        );
        const catalog = await (async () => {
          const signal = AbortSignal.timeout(10_000);
          for (;;) {
            signal.throwIfAborted();
            // Subscribe before reading so publication during the RPC is not missed.
            const publication = readback.nextPublication();
            const result = await racePromiseWithAbortSignal(
              call<ModelCatalogResult>("models.list", {
                agentId: "main",
                sessionKey,
                view: "configured",
                includeDetails: true,
              }),
              signal,
            );
            if (!result.pendingProviders?.length) {
              return result;
            }
            await racePromiseWithAbortSignal(publication, signal);
          }
        })();
        expect(catalog.models).toContainEqual(
          expect.objectContaining({ provider: loginProvider, id: "ready", available: true }),
        );
        await call("sessions.patch", { key: sessionKey, model: `${loginProvider}/ready` });
        await call("chat.send", {
          sessionKey,
          message: "Confirm this signed-in fixture works.",
          idempotencyKey: "browser-login-existing-session",
        });
        await expect
          .poll(async () => {
            finalHistory = await call("chat.history", { sessionKey });
            return JSON.stringify(finalHistory);
          })
          .toContain("Signed-in fixture reply");
        expect(fixture.requests).toContain("/models");
        expect(fixture.requests).toContain("/chat/completions");
        expect(pagePreviewRequests).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "after-restart.png") });
        await fs.copyFile(fixture.edgeReceipt, path.join(suite.artifactDir, "edge-receipt.json"));
      },
      async () => {
        await fs.writeFile(
          path.join(suite.artifactDir, "flow.json"),
          JSON.stringify(
            {
              callbacks,
              finalHistory,
              authorizations: fixture.authorizations,
              requests: fixture.requests,
              sessionKey,
            },
            null,
            2,
          ),
        );
      },
    );
  }, 120_000);
});
