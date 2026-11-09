import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { AgentToolGatewayRequestCaller } from "../../../src/agents/tools/in-process-gateway.ts";
import { runPersonalSessionGroups } from "../../../src/agents/tools/sessions-personal-groups.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { readUiBundle } from "./device-gateway.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Guest personal groups real Gateway",
  startServerBeforeBrowser: true,
});
const scopes = ["operator.sessions.read", "operator.sessions.write"];
const parentKey = "agent:main:dashboard:groups-parent";
const childKey = "agent:main:dashboard:groups-child";
const otherKey = "agent:main:dashboard:groups-other";
const people = ["groups-owner@example.test", "groups-other@example.test"];
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

function rpc<T>(page: Page, method: string, params: unknown): Promise<T> {
  return evaluateControlUiContext(
    page,
    async (app, request) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Guest Gateway client unavailable");
      }
      return client.request<T>(request.method, request.params);
    },
    { method, params },
  );
}

suite.define(() => {
  it("preserves children and profile groups through agent edits with only session permissions", async (test) => {
    let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
    let gateway: GatewayServer | undefined;
    const proxies: ViteDevServer[] = [];
    await suite.runScenario(test, {
      async run() {
        const port = await getFreePort();
        state = await createOpenClawTestState({
          label: "guest-personal-groups",
          layout: "home",
          env: {
            ...deviceGatewayEnv,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
          },
        });
        const profiles = people.map((email, index) => {
          const profile = ensureProfileForEmail(email);
          setUserProfileRole(profile.id, "guest");
          setDisplayName(profile.id, index ? "Guest Two" : "Guest One");
          return profile.id;
        });
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: people,
          deviceAutoApprove: { enabled: true, scopes },
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
              definitions: { guest: { agents: ["main"], sessions: { others: "none" }, scopes } },
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
        for (const [index, email] of people.entries()) {
          const route = gatewayProxyRoute(port, email, `192.0.2.${10 + index}`);
          const proxy = await createGatewayProxy(state.workspaceDir, {
            "/": { ...route, headers: { ...route.headers, "x-openclaw-scopes": scopes.join(",") } },
          });
          proxies.push(proxy);
          await proxy.listen();
          const url = new URL(proxy.resolvedUrls!.local[0]!);
          url.protocol = "ws:";
          urls.push(url.href);
        }
        const connect = async (page: Page, index: number) => {
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
          ).toEqual(scopes.toSorted());
          expect(await rpc(page, "users.self", {})).toMatchObject({
            profile: { id: profiles[index], role: "guest" },
          });
        };
        const setupContext = await suite.newBrowserContext({
          reducedMotion: "reduce",
          viewport: { width: 1280, height: 900 },
        });
        const editor = await setupContext.newPage();
        await connect(editor, 0);
        await rpc(editor, "sessions.create", {
          key: parentKey,
          label: "Reliability Tracker",
          category: "Engineering",
        });
        await rpc(editor, "sessions.create", {
          key: childKey,
          label: "Verification notes",
          parentSessionKey: parentKey,
        });
        await rpc(editor, "sessions.create", { key: otherKey, label: "Release checklist" });
        const initialStorage = await setupContext.storageState();
        const artifactDir = capture
          ? createControlUiE2eArtifactDir(
              "guest-personal-groups",
              process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
            )
          : undefined;
        await suite.withPage(
          {
            reducedMotion: "reduce",
            viewport: { width: 1280, height: 900 },
            storageState: initialStorage,
            ...(artifactDir
              ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
              : {}),
          },
          async ({ page }) => {
            const methods: string[] = [];
            const preferenceWrites: Record<string, unknown>[] = [];
            page.on("websocket", (socket) =>
              socket.on("framesent", (frame) => {
                const request = JSON.parse(frame.payload.toString());
                if (request.type === "req" && request.method !== "connect") {
                  methods.push(request.method);
                  if (request.method === "users.prefs.set") {
                    preferenceWrites.push(request.params.entries);
                  }
                }
              }),
            );
            let hold:
              | { phase: "request" | "response"; captured: boolean; seen: boolean }
              | undefined;
            let offline = false;
            let closeGuestConnection = () => Promise.resolve();
            await page.routeWebSocket(urls[0]!, async (socket) => {
              if (offline) {
                await socket.close();
                return;
              }
              closeGuestConnection = () => socket.close();
              const server = socket.connectToServer();
              let blockedResponseId: string | undefined;
              socket.onMessage((message) => {
                const frame: {
                  type?: string;
                  method?: string;
                  id?: string;
                  params?: { entries?: Record<string, unknown> };
                } = JSON.parse(message.toString());
                const groups = frame.params?.entries?.["ui.personalSessionGroups"];
                if (
                  hold &&
                  !hold.captured &&
                  frame.type === "req" &&
                  frame.method === "users.prefs.set" &&
                  Array.isArray(groups) &&
                  groups.some((item) => item.label === "Pending")
                ) {
                  hold.captured = true;
                  if (hold.phase === "request") {
                    hold.seen = true;
                    return;
                  }
                  blockedResponseId = frame.id;
                }
                server.send(message);
              });
              server.onMessage((message) => {
                const frame: { type?: string; id?: string; ok?: boolean } = JSON.parse(
                  message.toString(),
                );
                if (blockedResponseId && frame.type === "res" && frame.id === blockedResponseId) {
                  if (!frame.ok || !hold) {
                    throw new Error("Held collection save did not commit");
                  }
                  hold.seen = true;
                  return;
                }
                socket.send(message);
              });
            });
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
            await waitForControlUiGatewayReady(page);
            const sidebar = page.locator("openclaw-app-sidebar");
            const group = (label: string) =>
              sidebar
                .locator("[data-personal-session-group]")
                .filter({ has: page.getByRole("list", { name: label, exact: true }) });
            const create = async (label: string, member?: string) => {
              await sidebar.getByRole("button", { name: /^Filter & sort/ }).click();
              await page
                .locator(".sidebar-session-sort-menu")
                .getByRole("button", { name: "New section", exact: true })
                .click();
              const dialog = page.getByRole("dialog", { name: "New section", exact: true });
              await dialog.getByLabel("Section name", { exact: true }).fill(label);
              await dialog.getByRole("button", { name: "Choose sessions", exact: true }).click();
              if (member) {
                await dialog.getByRole("checkbox", { name: member, exact: true }).check();
              }
              await dialog.getByRole("button", { name: "Save", exact: true }).click();
              await dialog.waitFor({ state: "hidden" });
            };
            const menu = async (label: string, action: string) => {
              await sidebar
                .locator(".personal-session-groups__header", {
                  has: page.getByRole("button", {
                    name: `Options for section ${label}`,
                    exact: true,
                  }),
                })
                .hover();
              await sidebar
                .getByRole("button", { name: `Options for section ${label}`, exact: true })
                .click();
              await page.getByRole("menuitem", { name: action, exact: true }).click();
            };
            const toggle = sidebar.locator(`[data-child-session-toggle="${parentKey}"]`);
            await toggle.waitFor();
            if ((await toggle.getAttribute("aria-expanded")) === "false") {
              await toggle.click();
            }
            await sidebar.getByRole("link", { name: /Verification notes/ }).waitFor();
            methods.length = 0;
            for (const phase of ["request", "response"] as const) {
              // Exercise a real dropped request and a real committed save whose ACK
              // is lost with the tab. Only the existing browser outbox survives reload.
              hold = { phase, captured: false, seen: false };
              await create("Pending", "Reliability Tracker");
              await expect.poll(() => hold?.seen).toBe(true);
              await menu("Pending", "Remove section");
              await page.reload();
              await waitForControlUiGatewayReady(page);
              await expect.poll(() => group("Pending").count()).toBe(0);
              await expect
                .poll(() => rpc(editor, "users.prefs.get", { keys: ["ui.personalSessionGroups"] }))
                .toMatchObject({ entries: { "ui.personalSessionGroups": [] } });
              hold = undefined;
            }
            await create("Focus", "Reliability Tracker");
            await group("Focus")
              .getByRole("link", { name: /Verification notes/ })
              .waitFor();
            expect(await sidebar.locator(`[data-session-key="${childKey}"]`).count()).toBe(2);
            if (artifactDir) {
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator(".shell"),
                [group("Focus")],
                { animations: "disabled", elements: [page.locator(".shell")] },
              );
              await writeFile(path.join(artifactDir, "guest-group-children.png"), frame.png);
            }
            await rpc(editor, "sessions.patch", {
              key: childKey,
              label: "Updated verification notes",
            });
            await expect
              .poll(() => sidebar.getByRole("link", { name: /Updated verification notes/ }).count())
              .toBe(2);
            const focusId = await group("Focus").getAttribute("data-personal-session-group");
            if (!focusId) {
              throw new Error("Visible Focus collection has no identity");
            }
            const observed = [{ id: focusId, label: "Focus", sessionKeys: [parentKey] }];
            await expect
              .poll(
                async () =>
                  await rpc(page, "users.prefs.get", { keys: ["ui.personalSessionGroups"] }),
              )
              .toMatchObject({ entries: { "ui.personalSessionGroups": observed } });
            const agentRequest: AgentToolGatewayRequestCaller = <T>({
              method,
              params,
            }: Parameters<AgentToolGatewayRequestCaller>[0]) => rpc<T>(page, method, params ?? {});
            expect(
              (
                await runPersonalSessionGroups(
                  "personal_group_list",
                  { action: "personal_group_list" },
                  agentRequest,
                )
              ).details,
            ).toEqual({ status: "ok", groups: observed, expectedGroups: observed });
            const later = { id: "agent-later", label: "Later", sessionKeys: [otherKey] };
            await runPersonalSessionGroups(
              "personal_group_set",
              {
                action: "personal_group_set",
                groups: [...observed, later],
                expectedGroups: observed,
              },
              agentRequest,
            );
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await group("Later").waitFor();
            await group("Focus").waitFor();
            const order = () =>
              sidebar
                .locator("[data-personal-session-group] .sidebar-session-group-toggle")
                .allTextContents();
            // The UI intentionally disables new sections while disconnected. Queue its
            // real creation before delivery, reorder it, then lose the connection/tab.
            hold = { phase: "request", captured: false, seen: false };
            await create("Pending");
            await expect.poll(() => hold?.seen).toBe(true);
            await menu("Pending", "Move up");
            await menu("Pending", "Move up");
            await expect.poll(order).toEqual(["Pending", "Focus", "Later"]);
            offline = true;
            await closeGuestConnection();
            await expect
              .poll(() => evaluateControlUiContext(page, (app) => app.gateway.snapshot.phase))
              .not.toBe("connected");
            hold = undefined;
            offline = false;
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await expect.poll(order).toEqual(["Pending", "Focus", "Later"]);
            await expect
              .poll(() => rpc(page, "users.prefs.get", { keys: ["ui.personalSessionGroups"] }))
              .toMatchObject({
                entries: { "ui.personalSessionGroups": [{ label: "Pending" }, ...observed, later] },
              });
            await menu("Pending", "Remove section");
            await expect
              .poll(() => rpc(page, "users.prefs.get", { keys: ["ui.personalSessionGroups"] }))
              .toMatchObject({ entries: { "ui.personalSessionGroups": [...observed, later] } });
            await menu("Later", "Move up");
            await expect.poll(order).toEqual(["Later", "Focus"]);
            await menu("Focus", "Edit section");
            const dialog = page.getByRole("dialog", { name: "Edit section", exact: true });
            // Edits open on session choice; Back returns to the name.
            await dialog.getByRole("button", { name: "Back", exact: true }).click();
            await dialog.getByLabel("Section name", { exact: true }).fill("This week");
            await dialog.getByRole("button", { name: "Choose sessions", exact: true }).click();
            await dialog.getByRole("button", { name: "Save", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await expect.poll(order).toEqual(["Later", "This week"]);
            await expect
              .poll(() => rpc(page, "users.prefs.get", { keys: ["ui.personalSessionGroups"] }))
              .toMatchObject({
                status: "ok",
                entries: {
                  "ui.personalSessionGroups": [later, { ...observed[0], label: "This week" }],
                },
              });
            const freshContext = await suite.newBrowserContext({
              reducedMotion: "reduce",
              storageState: initialStorage,
            });
            const fresh = await freshContext.newPage();
            await fresh.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
            await waitForControlUiGatewayReady(fresh);
            await expect.poll(() => fresh.locator("[data-personal-session-group]").count()).toBe(2);
            await suite.closeBrowserContext(freshContext);
            await menu("This week", "Remove section");
            await expect.poll(order).toEqual(["Later"]);
            expect(await sidebar.locator(`[data-session-key="${parentKey}"]`).count()).toBe(1);
            const forbidden = new Set([
              "sessions.patch",
              "sessions.patchMany",
              "sessions.delete",
              "sessions.deleteMany",
              "sessions.groups.put",
              "sessions.groups.rename",
              "sessions.groups.update",
              "sessions.groups.defaults",
              "sessions.groups.delete",
              "config.patch",
              "config.set",
            ]);
            expect(methods.filter((method) => forbidden.has(method))).toEqual([]);
            expect(preferenceWrites.length).toBeGreaterThan(0);
            expect(
              preferenceWrites.every(
                (entries) =>
                  Object.keys(entries).length === 1 &&
                  Object.hasOwn(entries, "ui.personalSessionGroups"),
              ),
            ).toBe(true);
            if (artifactDir) {
              await writeFile(
                path.join(artifactDir, "runtime.json"),
                JSON.stringify({ bundle: await readUiBundle(page), scopes, sharedWrites: 0 }),
              );
            }
          },
          async ({ page, context }) => {
            const video = page.video();
            await suite.closeBrowserContext(context);
            if (artifactDir) {
              await video?.saveAs(path.join(artifactDir, "guest-groups.webm"));
            }
          },
        );
        const otherContext = await suite.newBrowserContext({ reducedMotion: "reduce" });
        const other = await otherContext.newPage();
        await connect(other, 1);
        await expect(rpc(other, "sessions.describe", { key: parentKey })).rejects.toThrow(
          `Session "${parentKey}" was not found.`,
        );
        expect(
          await rpc(other, "users.prefs.get", { keys: ["ui.personalSessionGroups"] }),
        ).toMatchObject({ status: "ok", entries: {} });
        await suite.closeBrowserContext(otherContext);
        await suite.closeBrowserContext(setupContext);
      },
      close: async () =>
        runQaGatewayFixture(
          async () => {},
          ...proxies.map((proxy) => () => proxy.close()),
          () => gateway?.close({ reason: "guest personal groups proof cleanup" }),
        ),
      release: async () => state?.cleanup(),
      retainedState: () => state?.root,
    });
  });
});
