import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayFrame } from "../../../packages/gateway-protocol/src/schema/frames.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { readUiBundle } from "./device-gateway.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Guest typing real Gateway",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard:guest-typing";
const people = [
  {
    email: "typing-guest@example.test",
    name: "Guest Writer",
    role: "guest",
    scopes: ["operator.sessions.read", "operator.sessions.write"],
  },
  {
    email: "typing-staff@example.test",
    name: "Staff Collaborator",
    role: "staff",
    scopes: ["operator.read", "operator.write"],
  },
];

function rpc<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return evaluateControlUiContext(
    page,
    async (app, request) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Authenticated fixture client missing");
      }
      return client.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

function observe(page: Page) {
  const sent: GatewayFrame[] = [];
  const received: GatewayFrame[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => sent.push(JSON.parse(frame.payload.toString())));
    socket.on("framereceived", (frame) => received.push(JSON.parse(frame.payload.toString())));
  });
  return { sent, received };
}

suite.define(() => {
  it("delivers an owned guest draft to a collaborator and the collaborator draft back", async (test) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: GatewayServer | undefined;
    const proxies: ViteDevServer[] = [];
    await suite.runScenario(test, {
      retainedState: () => state?.stateDir,
      async run() {
        const port = await getFreePort();
        state = await createOpenClawTestState({
          label: "guest-typing",
          layout: "home",
          env: {
            ...deviceGatewayEnv,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
          },
        });
        const profiles = people.map((person) => {
          const profile = ensureProfileForEmail(person.email);
          setUserProfileRole(profile.id, person.role);
          setDisplayName(profile.id, person.name);
          return profile.id;
        });
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
              default: "guest",
              definitions: {
                guest: {
                  agents: ["main"],
                  sessions: { others: "view" },
                  scopes: people[0]!.scopes,
                },
                staff: {
                  agents: ["main"],
                  sessions: { others: "write" },
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
        const urls: string[] = [];
        for (const [index, person] of people.entries()) {
          const route = gatewayProxyRoute(port, person.email, `192.0.2.${10 + index}`);
          const proxy = await createGatewayProxy(state.workspaceDir, {
            "/": {
              ...route,
              headers: { ...route.headers, "x-openclaw-scopes": person.scopes.join(",") },
            },
          });
          proxies.push(proxy);
          await proxy.listen();
          const url = new URL(proxy.resolvedUrls!.local[0]!);
          url.protocol = "ws:";
          urls.push(url.href);
        }
        const contexts = await Promise.all(
          people.map(() =>
            suite.newBrowserContext({
              reducedMotion: "reduce",
              viewport: { width: 1280, height: 900 },
            }),
          ),
        );
        const pages = await Promise.all(contexts.map((context) => context.newPage()));
        const wires = pages.map(observe);
        const bundles = [];
        for (const [index, page] of pages.entries()) {
          await page.addInitScript(() =>
            localStorage.setItem(
              "openclaw:control-ui:community-invite:v2",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            ),
          );
          const url = new URL("new", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: urls[index]! }).toString();
          await page.goto(url.href);
          await page
            .locator("openclaw-gateway-url-confirmation")
            .getByRole("button", { name: `Switch to ${new URL(urls[index]!).host}`, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);
          expect(
            await evaluateControlUiContext(page, (app) =>
              app.gateway.snapshot.hello?.auth?.scopes?.toSorted(),
            ),
          ).toEqual(people[index]!.scopes.toSorted());
          expect(await rpc(page, "users.self", {})).toMatchObject({
            profile: { id: profiles[index], role: people[index]!.role },
          });
          if (index === 0) {
            await rpc(page, "sessions.create", { key: sessionKey, label: "Shared planning notes" });
          }
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await waitForControlUiGatewayReady(page);
          await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
          bundles.push(await readUiBundle(page));
        }
        const guest = pages[0]!;
        const staff = pages[1]!;
        const composers = pages.map((page) =>
          page.getByRole("textbox", { name: "Chat composer", exact: true }),
        );
        // Both real subscribers must be watching before the UI enables ephemeral previews.
        await expect
          .poll(() =>
            evaluateControlUiContext(
              guest,
              (app) =>
                app.gateway
                  .readPresence?.()
                  ?.filter((entry) =>
                    entry.watchedSessions?.includes("agent:main:dashboard:guest-typing"),
                  ).length ?? 0,
            ),
          )
          .toBeGreaterThanOrEqual(2);
        await composers[1]!.fill("Staff draft visible to the guest");
        await expect
          .poll(() => guest.locator(".agent-chat__typing-preview-text").textContent())
          .toContain("Staff draft visible to the guest");
        await composers[1]!.fill("");
        await expect.poll(() => guest.locator(".agent-chat__typing-preview-text").count()).toBe(0);
        const draft = "Guest draft: compare the release checklist";
        await composers[0]!.fill(draft);
        const delivered = await expect
          .poll(
            async () =>
              (await staff.locator(".agent-chat__typing-preview-text").allTextContents()).join(""),
            { timeout: 5_000 },
          )
          .toContain(draft)
          .then(
            () => true,
            () => false,
          );
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            staff,
            staff.locator(".chat-pane-cache__pane--active .chat"),
            [composers[1]!],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "collaborator.png"), frame.png);
        }
        const guestTypingRequests = wires[0]!.sent.filter(
          (frame) => frame.type === "req" && frame.method === "session.typing",
        );
        const description = await rpc<{ session: { sessionId: string } }>(
          guest,
          "sessions.describe",
          { key: sessionKey },
        );
        const direct = await rpc(guest, "session.typing", {
          sessionKey,
          sessionId: description.session.sessionId,
          typing: true,
          preview: draft,
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error: String(error) }),
        );
        await writeFile(
          path.join(suite.artifactDir, "typing-proof.json"),
          JSON.stringify(
            {
              bundles,
              delivered,
              direct,
              guestTypingRequests,
              staffTypingEvents: wires[1]!.received.filter(
                (frame) => frame.type === "event" && frame.event === "session.typing",
              ),
            },
            null,
            2,
          ),
        );
        expect.soft(delivered, "The collaborator must receive the guest composer draft").toBe(true);
        expect(direct).not.toHaveProperty("error");
      },
      async close() {
        await runQaGatewayFixture(
          async () => {},
          ...proxies.map((proxy) => () => proxy.close()),
          () => gateway?.close({ reason: "guest typing fixture cleanup" }),
          () => state?.cleanup(),
        );
      },
    });
  });
});
