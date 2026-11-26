import { fileURLToPath } from "node:url";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import type { ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import type { ToolsInvokeResult } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { setUserProfileRole } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createVisitorAccessPluginConfig } from "../../../src/test-utils/visitor-access-config.test-support.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Visitor Access notices through a real Gateway" });
const guestEmail = "visitor-notices-guest@example.test";
const adminEmail = "visitor-notices-admin@example.test";
const account = "/client/v4/accounts/proof-account";
const collection = account + "/access/apps/proof-app/policies";

function installPolicyFixture() {
  const fetchActual = globalThis.fetch;
  let policy: { id: string; name: string; decision: string; include: unknown[] } | undefined;
  vi.stubGlobal("fetch", (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://api.cloudflare.com") {
      return await fetchActual(input, init);
    }
    const respond = (result: unknown) => Response.json({ success: true, result });
    switch (url.pathname) {
      case account + "/entitlements":
        return respond([
          {
            id: "teams.users_allowed",
            deleted_date: "",
            allocation: { type: "max_count", value: 10 },
          },
        ]);
      case account + "/access/users":
        return respond([]);
      case collection:
      case collection + "/proof-policy":
        switch (init?.method ?? "GET") {
          case "GET":
            return respond(url.pathname === collection ? (policy ? [policy] : []) : policy);
          case "POST":
          case "PUT":
            if (typeof init?.body !== "string") {
              throw new Error("Cloudflare policy fixture expected a JSON body");
            }
            policy = { ...JSON.parse(init.body), id: "proof-policy" };
            return respond(policy);
          case "DELETE":
            policy = undefined;
            return respond(null);
        }
    }
    throw new Error("Unexpected Cloudflare call in isolated visitor proof: " + url.pathname);
  }) satisfies typeof fetch);
}

function rpc<T>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return evaluateControlUiContext(
    page,
    async (app, request) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Authenticated Gateway client missing");
      }
      return client.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

suite.define(() => {
  it("keeps one welcome chat and uses System for a re-invite and an in-place extension", async (test) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: GatewayServer | undefined;
    const proxies: ViteDevServer[] = [];
    await suite.runScenario(test, {
      retainedState: () => state?.stateDir,
      async run() {
        const port = await getFreePort();
        state = await createOpenClawTestState({
          label: "visitor-access-notice",
          layout: "home",
          env: {
            ...deviceGatewayEnv,
            OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(
              new URL("../../../extensions/", import.meta.url),
            ),
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
          },
        });
        installPolicyFixture();
        const admin = ensureProfileForEmail(adminEmail);
        setUserProfileRole(admin.id, "admin");
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [guestEmail, adminEmail],
          deviceAutoApprove: {
            enabled: true,
            scopes: ["operator.sessions.write", "operator.admin"],
          },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            defaults: { workspace: state.workspaceDir, model: "fixture/echo" },
            entries: { main: {} },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              fixture: {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:9/v1",
                apiKey: "synthetic-fixture-key",
                models: [{ id: "echo", name: "Fixture model" }],
              },
            },
          },
          gateway: {
            port,
            auth: { mode: "trusted-proxy", trustedProxy },
            trustedProxies: ["127.0.0.1", "::1"],
            controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
            roles: {
              default: "guest",
              definitions: {
                guest: {
                  accessPolicyPlugin: "visitor-access",
                  agents: ["main"],
                  sessions: { others: "view" },
                  scopes: ["operator.sessions.write"],
                  sandbox: "required",
                  modelPolicy: { allow: ["fixture/echo"] },
                },
                admin: {
                  agents: ["main"],
                  sessions: { others: "write" },
                  scopes: ["operator.admin"],
                },
              },
            },
          },
          tools: { allow: ["visitor_invite", "visitor_revoke", "visitor_list"] },
          plugins: createVisitorAccessPluginConfig(
            "proof-account",
            "proof-app",
            "synthetic-access-token",
          ),
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        const connect = async (email: string, scopes: string, forwardedFor: string) => {
          const route = gatewayProxyRoute(port, email, forwardedFor);
          const proxy = await createGatewayProxy(state!.workspaceDir, {
            "/": { ...route, headers: { ...route.headers, "x-openclaw-scopes": scopes } },
          });
          proxies.push(proxy);
          await proxy.listen();
          const addr = new URL(proxy.resolvedUrls!.local[0]!);
          addr.protocol = "ws:";
          return addr;
        };
        const [adminAddr, guestAddr] = await Promise.all([
          connect(adminEmail, "operator.admin", "192.0.2.10"),
          connect(guestEmail, "operator.sessions.write", "192.0.2.11"),
        ]);
        const open = async (addr: URL) => {
          const context = await suite.newBrowserContext({ locale: "en-US", timezoneId: "UTC" });
          const page = await context.newPage();
          const url = new URL(suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: addr.href }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: "Switch to " + addr.host, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);
          return page;
        };
        const adminPage = await open(adminAddr);
        const invite = async (
          name: "visitor_invite" | "visitor_revoke",
          args: Record<string, unknown>,
        ) => {
          const result = await rpc<ToolsInvokeResult>(adminPage, "tools.invoke", {
            name,
            args: { email: guestEmail, ...args },
          });
          expect(result).toMatchObject({ ok: true, output: { content: expect.any(Array) } });
          if (!result.ok) {
            throw new Error("Synthetic invitation failed: " + result.error?.message);
          }
          expect(result.output).not.toHaveProperty("isError", true);
          return asNullableRecord(asNullableRecord(result.output)?.details);
        };
        await invite("visitor_invite", { days: 2, note: "First invitation note." });
        const first = await open(guestAddr);
        await expectBrowser(first.getByRole("group", { name: /^Welcome / })).toBeVisible({
          timeout: 20_000,
        });
        type WelcomeRow = {
          key: string;
          sessionId: string;
          displayName?: string;
          label?: string;
          archived?: boolean;
        };
        const welcomeRows = async (page: Page) =>
          (
            await rpc<{ sessions: WelcomeRow[] }>(page, "sessions.list", { archived: "all" })
          ).sessions.filter((row) => (row.displayName ?? row.label)?.startsWith("Welcome "));
        const initialWelcomes = await welcomeRows(first);
        expect(initialWelcomes).toHaveLength(1);
        const [original] = initialWelcomes;
        expect(
          JSON.stringify(await rpc(first, "chat.history", { sessionKey: original!.key })),
        ).toContain("First invitation note.");
        await rpc(adminPage, "sessions.patch", {
          key: original!.key,
          expectedSessionId: original!.sessionId,
          archived: true,
        });
        await suite.closeBrowserContext(first.context());
        await invite("visitor_revoke", {});
        await invite("visitor_invite", { days: 3, note: "Restored invitation note." });
        const returning = await open(guestAddr);
        await expect
          .poll(
            async () =>
              (await rpc<{ status: string }>(returning, "visitor-access.welcome.ensure")).status,
          )
          .toMatch(/^(ready|not_applicable)$/);
        expect(await welcomeRows(returning)).toEqual([
          expect.objectContaining({ key: original!.key, archived: true }),
        ]);
        await returning.locator(".sidebar-issues-button:visible").click();
        const inbox = returning.locator("#sidebar-issues-panel");
        await inbox.getByRole("tab", { name: /System/ }).click();
        await inbox.getByText("Welcome back — access restored", { exact: true }).click();
        await expectBrowser(inbox.getByText("Restored invitation note.")).toBeVisible();

        const extension = await invite("visitor_invite", { days: 14 });
        if (typeof extension?.expiresAt !== "string") {
          throw new Error("The invitation receipt did not include an expiry");
        }
        const expiry = new Date(extension.expiresAt);
        const expiryLabel = new Intl.DateTimeFormat("en-US", {
          timeZone: "UTC",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(expiry);
        await returning.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expectBrowser(
          inbox.getByText("Guest access extended", { exact: true }),
        ).toBeVisible();
        await expectBrowser(
          inbox.getByText("Expires " + expiryLabel, { exact: true }).first(),
        ).toBeVisible();
        expect(await welcomeRows(returning)).toEqual([
          expect.objectContaining({ key: original!.key, archived: true }),
        ]);
      },
      async close() {
        await Promise.all(proxies.map((proxy) => proxy.close()));
        await gateway?.close({ reason: "Visitor Access notice proof finished" });
        vi.unstubAllGlobals();
      },
      async release() {
        await state?.cleanup();
      },
    });
  });
});
