import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Read-only Home real Gateway",
  startServerBeforeBrowser: true,
});
const homeKey = "agent:main:main";
const message = "Home notes: the release checklist is ready for review.";

function rpc<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return evaluateControlUiContext(
    page,
    async (app, request) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Fixture client is not connected");
      }
      return client.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

suite.define(() => {
  it("opens existing Home for a reader without granting writes and hides denied targets", async (test) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: GatewayServer | undefined;
    const proxies: ViteDevServer[] = [];
    await suite.runScenario(test, {
      retainedState: () => state?.stateDir,
      async run() {
        state = await createOpenClawTestState({
          label: "home-readonly",
          layout: "home",
          env: {
            ...deviceGatewayEnv,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
          },
        });
        const people = [
          {
            email: "home-owner@example.test",
            name: "Home Owner",
            role: "owner",
            scopes: ["operator.read", "operator.write", "operator.admin"],
          },
          {
            email: "home-reader@example.test",
            name: "Home Reader",
            role: "reader",
            scopes: ["operator.sessions.read"],
          },
        ];
        for (const person of people) {
          const profile = ensureProfileForEmail(person.email);
          setUserProfileRole(profile.id, person.role);
          setDisplayName(profile.id, person.name);
        }
        const port = await getFreePort();
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: people.map((person) => person.email),
          deviceAutoApprove: { enabled: true, scopes: people.flatMap((person) => person.scopes) },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: state.workspaceDir,
              model: "fixture/echo",
              modelPolicy: { allow: ["fixture/echo"] },
            },
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
              default: "reader",
              definitions: {
                owner: {
                  agents: ["main"],
                  sessions: { others: "write" },
                  scopes: people[0]!.scopes,
                },
                reader: {
                  agents: ["main"],
                  sessions: { others: "view" },
                  scopes: people[1]!.scopes,
                },
              },
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
        const pages: Page[] = [];
        for (const [index, person] of people.entries()) {
          const route = gatewayProxyRoute(port, person.email, "192.0.2." + (10 + index));
          const proxy = await createGatewayProxy(state.workspaceDir, {
            "/": {
              ...route,
              headers: { ...route.headers, "x-openclaw-scopes": person.scopes.join(",") },
            },
          });
          proxies.push(proxy);
          await proxy.listen();
          const gatewayUrl = new URL(proxy.resolvedUrls!.local[0]!);
          gatewayUrl.protocol = "ws:";
          const context = await suite.newBrowserContext({
            reducedMotion: "reduce",
            viewport: { width: 1280, height: 900 },
          });
          const page = await context.newPage();
          pages.push(page);
          const url = new URL("sessions", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", {
              name: "Switch to " + gatewayUrl.host,
              exact: true,
            })
            .click();
          await waitForControlUiGatewayReady(page);
          expect(
            await evaluateControlUiContext(page, (app) =>
              app.gateway.snapshot.hello?.auth?.scopes?.toSorted(),
            ),
          ).toEqual(person.scopes.toSorted());
          if (index === 0) {
            await rpc(page, "sessions.create", { key: homeKey, label: "Home release notes" });
            await rpc(page, "chat.inject", { sessionKey: homeKey, message });
          }
        }
        const owner = pages[0]!;
        const reader = pages[1]!;
        const button = reader.getByRole("button", { name: "Talk to your Home agent", exact: true });
        await button.waitFor({ state: "visible" });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && (await button.isDisabled())) {
          const frame = await takeControlUiScreenshotFrame(
            reader,
            reader.locator("body"),
            [button],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "before.png"), frame.png);
        }
        expect(await button.isEnabled(), "Reading Home must not require chat.send").toBe(true);
        await button.click();
        const dock = reader.locator("openclaw-assistant-panel");
        await dock.getByText(message, { exact: true }).waitFor({ state: "visible" });
        const composer = dock.getByRole("textbox", { name: "Chat composer", exact: true });
        expect(await composer.isDisabled()).toBe(true);
        await expect(
          rpc(reader, "chat.send", {
            sessionKey: homeKey,
            message: "Forbidden write",
            idempotencyKey: "reader-write",
          }),
        ).rejects.toThrow();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            reader,
            reader.locator("body"),
            [dock.getByText(message, { exact: true })],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "after.png"), frame.png);
        }
        await dock.getByRole("button", { name: "Open Home full page", exact: true }).click();
        await reader
          .locator("openclaw-chat-page")
          .getByText(message, { exact: true })
          .waitFor({ state: "visible" });
        // Draft protection is the same target-session policy in both presentations.
        await rpc(owner, "session.visibility.set", { sessionKey: homeKey, visibility: "draft" });
        await reader.reload();
        await waitForControlUiGatewayReady(reader);
        await expect.poll(() => reader.getByText(message, { exact: true }).count()).toBe(0);
        await reader.goto(new URL("sessions", suite.server.baseUrl).href);
        await waitForControlUiGatewayReady(reader);
        // The saved dock can already be restored on return; open rather than toggle it closed.
        await reader.evaluate(
          (name) => window.dispatchEvent(new CustomEvent(name, { detail: { open: true } })),
          HOME_PANEL_TOGGLE_EVENT,
        );
        await expect(rpc(reader, "chat.history", { sessionKey: homeKey })).rejects.toThrow();
        await dock.getByText(/^This Home is unavailable\./).waitFor({ state: "visible" });
        expect(
          await dock.getByRole("textbox", { name: "Chat composer", exact: true }).count(),
        ).toBe(0);
        expect(await reader.getByText(message, { exact: true }).count()).toBe(0);
      },
      async close() {
        await runQaGatewayFixture(
          async () => {},
          ...proxies.map((proxy) => () => proxy.close()),
          () => gateway?.close({ reason: "Home reader proof cleanup" }),
          () => state?.cleanup(),
        );
      },
    });
  });
});
