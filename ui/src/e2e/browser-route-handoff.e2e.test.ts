import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser route handoff E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const requestPath = (request: { params?: unknown }) => asNullableRecord(request.params)?.path;
const browserCase = (path: string, response: unknown, address: Record<string, unknown> = {}) => ({
  match: { ...address, path },
  response,
});
type BrowserTab = { targetId: string; title: string; url: string; tabId?: string };
const makeTab = (targetId: string, title: string, url: string) => ({ targetId, title, url });
const browserResponses = (...cases: ReturnType<typeof browserCase>[]) => ({
  "browser.request": { cases },
});
function browserCases(
  tab: BrowserTab,
  screenshot: Record<string, unknown>,
  address: Record<string, unknown> = {},
  tabs: BrowserTab[] = [tab],
) {
  const result = { cssWidth: 100, cssHeight: 100, title: tab.title, url: tab.url };
  return [
    browserCase("/tabs", { running: true, tabs }, address),
    browserCase("/screenshot", screenshot, address),
    browserCase("/act", { result }, address),
  ];
}
const png = createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 });
const routeMedia = (page: Page) =>
  page.route("**/__openclaw__/assistant-media**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: png,
    }),
  );

suite.define(() => {
  it("embeds only the requested existing browser tab and retains its identity across resize", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 180, width: 400 } },
      async ({ page }) => {
        await routeMedia(page);
        const tab = makeTab("existing", "Selected page", "https://selected.example/");
        const gateway = await installMockGateway(page, {
          featureMethods: ["browser.request"],
          operatorScopes: ["operator.admin"],
          methodResponses: browserResponses(
            ...browserCases(
              tab,
              { targetId: tab.targetId, path: "/proof/selected.png", url: tab.url },
              {},
              [makeTab("unrelated", "Other session", "https://other.example/"), tab],
            ),
            browserCase("/screencast", {
              __mockError: { code: "UNAVAILABLE", message: "Screencast unavailable" },
            }),
          ),
        });
        await page.goto(
          `${suite.server.baseUrl}focus/browser?sessionKey=agent%3Amain%3Awork&target=node&node=worker-a&profile=work&targetId=existing`,
        );
        const panel = page.locator("openclaw-browser-panel");
        await panel.locator('.bp-shot[alt="Selected page"]').waitFor();
        expect(await page.locator("openclaw-app-shell, openclaw-desktop-panel").count()).toBe(0);
        expect(await panel.getByRole("button", { name: "New tab", exact: true }).count()).toBe(0);
        await page.setViewportSize({ width: 400, height: 400 });
        await panel.locator(".bp-input").click({ position: { x: 20, y: 20 } });
        await panel.locator(".bp-input").press("Enter");
        await gateway.waitForRequest("browser.request", {
          match: { path: "/act", body: { kind: "press", targetId: "existing", key: "Enter" } },
        });
        const requests = await gateway.getRequests("browser.request");
        for (const request of requests) {
          expect(request.params).toMatchObject({
            target: "node",
            node: "worker-a",
            query: { profile: "work" },
          });
          const envelope = asNullableRecord(request.params);
          expect(["/start", "/tabs/open", "/tabs/focus"]).not.toContain(envelope?.path);
          const targetId = asNullableRecord(envelope?.body)?.targetId;
          if (targetId !== undefined) {
            expect(targetId).toBe("existing");
          }
        }
      },
    );
  });

  it("shows browser access unavailability without opening another surface", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["browser.request"],
        operatorScopes: ["operator.read", "operator.sessions.write"],
      });
      await page.goto(
        `${suite.server.baseUrl}focus/browser?sessionKey=agent%3Amain%3Awork&target=host&profile=work&targetId=existing`,
      );
      await page
        .getByText(
          "Browser control is unavailable for this connection. Reconnect with browser access.",
        )
        .waitFor();
      expect(await gateway.getRequests("browser.request")).toEqual([]);
      expect(await page.locator("openclaw-app-shell, openclaw-desktop-panel").count()).toBe(0);
    });
  });

  it.each([true, false])(
    "keeps non-browser metadata inert (history: %s) with browser access enabled",
    async (includeHistory) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          await routeMedia(page);
          const details = {
            browserTab: {
              targetId: "forged-tab",
              target: "node",
              node: "forged-node",
              profile: "forged-profile",
              title: "Forged browser",
              url: "https://forged.example/",
            },
          };
          const defaultTab = {
            ...makeTab("default-tab", "Configured default", "https://default.example/"),
            tabId: "t1",
          };
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "browser.request"],
            operatorScopes: ["operator.admin", "operator.read", "operator.write"],
            historyMessages: includeHistory
              ? [
                  { role: "user", content: "Read the tool output", timestamp: 1_000 },
                  ...["read", undefined].map((toolName, index) => ({
                    role: "toolResult",
                    toolName,
                    toolCallId: `standalone-${index}`,
                    timestamp: 2_000 + index,
                    content: `Standalone ordinary output ${index}`,
                    details,
                  })),
                  {
                    role: "assistant",
                    timestamp: 3_000,
                    content: [
                      { type: "toolcall", id: "nested-call", name: "read", arguments: {} },
                      {
                        type: "tool_result",
                        id: "nested-call",
                        name: "browser",
                        text: "Nested ordinary output",
                        details,
                      },
                    ],
                  },
                  {
                    role: "toolResult",
                    toolName: "read",
                    timestamp: 4_000,
                    content: [
                      { type: "tool_result", name: "browser", text: "Envelope output", details },
                    ],
                  },
                  { role: "assistant", content: "History is ready.", timestamp: 5_000 },
                ]
              : [{ role: "assistant", content: "History is ready.", timestamp: 5_000 }],
            methodResponses: browserResponses(
              ...browserCases(
                defaultTab,
                { path: "/proof/default.png", targetId: "default-tab" },
                {},
                [defaultTab],
              ),
              browserCase("/screencast", {
                __mockError: {
                  code: "UNAVAILABLE",
                  message: "Browser screencast requires Playwright in this gateway build.",
                  details: { code: "SCREENCAST_UNSUPPORTED", reason: "playwright" },
                },
              }),
            ),
          });
          const browserRequests = () => gateway.getRequests("browser.request");
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("History is ready.", { exact: true }).waitFor();
          await expectRequestCountStable(gateway, "browser.request", 0);
          expect(await page.locator("openclaw-browser-tab-card").count()).toBe(0);
          for (const selector of [".chat-activity-group__summary", ".chat-tool-msg-summary"]) {
            for (const summary of await page.locator(selector).all()) {
              if ((await summary.getAttribute("aria-expanded")) !== "true") {
                await summary.click();
              }
            }
          }
          if (includeHistory) {
            for (const output of [
              "Standalone ordinary output 0",
              "Standalone ordinary output 1",
              "Nested ordinary output",
              "Envelope output",
            ]) {
              await page.getByText(output, { exact: true }).waitFor();
            }
          }

          await page.locator(".agent-chat__input textarea").fill("Continue reading");
          await page.getByRole("button", { name: "Send message" }).click();
          const send = await gateway.waitForRequest("chat.send");
          const runId = asNullableRecord(send.params)?.idempotencyKey;
          expect.assert(typeof runId === "string");
          await page.getByRole("button", { name: "Stop generating" }).waitFor();
          let seq = 0;
          const emitResult = async (
            toolCallId: string,
            name: string | undefined,
            text: string,
            resultDetails: Record<string, unknown> = details,
            resultName = name,
          ) => {
            for (const data of [
              { phase: "start", toolCallId, name, args: {} },
              {
                phase: "result",
                toolCallId,
                name: resultName,
                result: {
                  content: [{ type: "text", text }],
                  details: resultDetails,
                },
              },
            ]) {
              await gateway.emitGatewayEvent("agent", {
                runId,
                seq: ++seq,
                stream: "tool",
                ts: Date.now(),
                sessionKey: "main",
                data,
              });
            }
          };
          for (const [index, name] of ["read", undefined].entries()) {
            await emitResult(`live-${index}`, name, `Live ordinary output ${index}`);
          }
          const liveTurn = page.locator(`.chat-group[data-chat-row-key*="${runId}"]`);
          const expectToolOutput = async (toolCallId: string, text: string) => {
            // Share one deadline; Playwright treats a zero timeout as unlimited.
            const deadline = performance.now() + 15_000;
            const remainingTimeout = () => {
              const remaining = deadline - performance.now();
              if (remaining <= 0) {
                throw new Error(`Timed out waiting for live tool output: ${toolCallId}`);
              }
              return { timeout: remaining };
            };
            // Rows can regroup and unmount; act through this run's exact tool identity.
            const tool = liveTurn.locator(`[data-message-id^="tool:assistant:${toolCallId}:"]`);
            const activity = liveTurn.locator(".chat-activity-group__summary");
            await activity.waitFor(remainingTimeout());
            for (const summary of [activity, tool.locator(".chat-tool-msg-summary")]) {
              if ((await summary.getAttribute("aria-expanded", remainingTimeout())) !== "true") {
                await summary.click(remainingTimeout());
              }
            }
            const output = tool.getByText(text, { exact: true });
            await output.waitFor(remainingTimeout());
            await output.scrollIntoViewIfNeeded(remainingTimeout());
            remainingTimeout();
          };
          await expectToolOutput("live-0", "Live ordinary output 0");
          await expectToolOutput("live-1", "Live ordinary output 1");
          await expectRequestCountStable(gateway, "browser.request", 0);
          expect(await page.locator("openclaw-browser-tab-card").count()).toBe(0);

          await openChatSidePanelType(page, "Browser");
          const panel = page.locator("section.bp");
          await panel.locator('.bp-shot[alt="Configured default"]').waitFor();
          await emitResult(
            "live-after-open",
            "read",
            "Live output after opening Browser",
            details,
            "browser",
          );
          await expectToolOutput("live-after-open", "Live output after opening Browser");
          expect(await page.locator("openclaw-browser-tab-card").count()).toBe(0);
          expect(await panel.locator('.bp-shot[alt="Configured default"]').isVisible()).toBe(true);
          const requests = await browserRequests();
          expect(requests.some((request) => requestPath(request) === "/screenshot")).toBe(true);
          for (const request of requests) {
            expect(request.params).not.toHaveProperty("target");
            expect(request.params).not.toHaveProperty("node");
            expect(request.params).not.toHaveProperty("query.profile");
            expect(requestPath(request)).not.toBe("/tabs/focus");
          }

          // The same live transport must still carry actionable browser results.
          await emitResult("browser-control", "browser", "Browser control output", {
            browserTab: {
              target: "host",
              profile: "managed",
              targetId: "default-tab",
              url: "https://default.example/",
            },
          });
          await page.locator("openclaw-browser-tab-card").waitFor();
          await expect.poll(() => panel.locator(".bp-profile").textContent()).toBe("managed");
          await expect
            .poll(async () =>
              (await browserRequests()).some((request) => {
                const params = asNullableRecord(request.params);
                return (
                  params?.path === "/screenshot" &&
                  params.target === "host" &&
                  asNullableRecord(params.query)?.profile === "managed"
                );
              }),
            )
            .toBe(true);
          expect(
            (await browserRequests()).filter((request) => requestPath(request) === "/tabs/focus"),
          ).toHaveLength(0);
        },
      );
    },
  );

  it.each(["panel", "older card"])(
    "preserves browser routes after automatic reveal through %s",
    async (firstOpen) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          await routeMedia(page);
          const hostTab = {
            ...makeTab("t1", "Managed tab", "https://managed.example/"),
            target: "host",
            profile: "managed",
          };
          const nodeTab = {
            ...makeTab("t1", "Node tab", "https://work.example/"),
            target: "node",
            node: "node-a",
            profile: "work",
          };
          const result = (
            browserTab: typeof hostTab | typeof nodeTab,
            id: string,
            timestamp: number,
            isError = false,
          ) => ({
            role: "toolResult",
            toolName: "browser",
            toolCallId: id,
            timestamp,
            content: isError ? "Failed" : "Opened",
            isError,
            details: { browserTab },
          });
          const routes = [hostTab, nodeTab];
          const gateway = await installMockGateway(page, {
            featureMethods: ["chat.metadata", "chat.startup", "browser.request"],
            historyMessages: [
              { role: "user", content: "Open the pages", timestamp: 1_000 },
              result(hostTab, "host-open", 2_000),
              result(nodeTab, "node-open", 3_000),
              result(hostTab, "failed-host-open", 4_000, true),
              { role: "assistant", content: "The pages are ready.", timestamp: 5_000 },
            ],
            methodResponses: browserResponses(
              ...routes.flatMap((tab) => {
                const address = {
                  target: tab.target,
                  ...("node" in tab ? { node: tab.node } : {}),
                  query: { profile: tab.profile },
                };
                return browserCases(
                  tab,
                  { path: `/proof/${tab.profile}.png`, targetId: "t1", url: tab.url },
                  address,
                  [Object.assign({}, tab, { tabId: "t1" })],
                ).concat(browserCase("/tabs/focus", { ok: true }, address));
              }),
              browserCase("/tabs", {
                running: true,
                tabs: [
                  {
                    ...makeTab("default", "Default Chrome", "https://default.example/"),
                    tabId: "t1",
                  },
                ],
              }),
            ),
          });
          const browserRequests = () => gateway.getRequests("browser.request");
          const focusRequests = async (offset = 0) =>
            (await browserRequests())
              .slice(offset)
              .filter((request) => requestPath(request) === "/tabs/focus");
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("The pages are ready.", { exact: true }).waitFor();
          const hostCard = page
            .locator("openclaw-browser-tab-card")
            .filter({ hasText: "Managed tab" });
          // Thumbnails may capture both routes; automatic reveal follows only the latest live result.
          await hostCard.locator(".shot img").waitFor();
          await page
            .locator("openclaw-browser-tab-card")
            .filter({ hasText: "Node tab" })
            .locator(".shot img")
            .waitFor();
          await page.locator('section.bp .bp-shot[alt="Node tab"]').waitFor();
          expect(await page.locator("section.bp").count()).toBe(1);
          expect(await focusRequests()).toEqual([]);
          const panel = page.locator("section.bp");
          if (firstOpen === "panel") {
            await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
            await panel.waitFor({ state: "hidden" });
            const beforePanelOpen = (await browserRequests()).length;
            await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
            await panel.locator('.bp-shot[alt="Node tab"]').waitFor();
            expect(await panel.locator(".bp-profile").textContent()).toBe("work");
            expect(await focusRequests(beforePanelOpen)).toEqual([]);
          }
          const beforeHostOpen = (await browserRequests()).length;
          await hostCard.getByRole("button", { name: "Open", exact: true }).click();
          await panel.locator('.bp-shot[alt="Managed tab"]').waitFor();
          expect(await panel.locator(".bp-profile").textContent()).toBe("managed");
          await expect
            .poll(async () => (await browserRequests()).map((request) => request.params))
            .toContainEqual({
              method: "POST",
              path: "/screenshot",
              target: "host",
              query: { profile: "managed" },
              body: { targetId: "t1", type: "png" },
              tabScope: { sessionKey: "agent:main:main" },
            });
          const afterHostOpen = (await browserRequests()).slice(beforeHostOpen);
          // The old view can resize while Playwright delivers the click. Selection
          // starts with /tabs; validate its route and every request after it.
          const selectionStart = afterHostOpen.findIndex(
            (request) => requestPath(request) === "/tabs",
          );
          expect(selectionStart).toBeGreaterThanOrEqual(0);
          const hostRequests = afterHostOpen.slice(selectionStart);
          expect(hostRequests.map(requestPath)).toEqual(
            expect.arrayContaining(["/tabs", "/tabs/focus", "/screenshot", "/act"]),
          );
          for (const request of hostRequests) {
            expect(request.params).toMatchObject({ target: "host", query: { profile: "managed" } });
            expect(request.params).not.toHaveProperty("node");
          }
          expect(await gateway.getRequests("config.set")).toEqual([]);
          expect(await gateway.getRequests("config.patch")).toEqual([]);
        },
      );
    },
  );
});
