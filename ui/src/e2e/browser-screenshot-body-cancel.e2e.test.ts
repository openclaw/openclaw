import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser screenshot failed-body E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

type ScreenshotProof = {
  cancelCount: number;
  cancelResolvedCount: number;
  fetchCount: number;
  statuses: number[];
};

suite.define(() => {
  it("keeps the status error visible and cancels the unread media body", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.removeItem("openclaw.browser.panel.v1");
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await originalFetch(input, init);
          const url = input instanceof Request ? input.url : String(input);
          if (!url.includes("/__openclaw__/assistant-media") || !response.body) {
            return response;
          }
          const proofWindow = window as Window & { openclawScreenshotProof?: ScreenshotProof };
          const proof = (proofWindow.openclawScreenshotProof ??= {
            cancelCount: 0,
            cancelResolvedCount: 0,
            fetchCount: 0,
            statuses: [],
          });
          proof.fetchCount += 1;
          proof.statuses.push(response.status);
          const originalCancel = response.body.cancel.bind(response.body);
          response.body.cancel = async (reason) => {
            proof.cancelCount += 1;
            await originalCancel(reason);
            proof.cancelResolvedCount += 1;
          };
          return response;
        };
      });
      let mediaRequest: { authorization: string; source: string | null } | null = null;
      await page.route("**/__openclaw__/assistant-media**", (route) => {
        const request = route.request();
        mediaRequest = {
          authorization: request.headers().authorization ?? "",
          source: new URL(request.url()).searchParams.get("source"),
        };
        return route.fulfill({
          body: "screenshot unavailable",
          contentType: "text/plain; charset=utf-8",
          status: 404,
        });
      });
      const target = { targetId: "target-1", url: "https://example.test/" };
      const responseCase = (method: string, requestPath: string, response: unknown) => ({
        match: { method, path: requestPath },
        response,
      });
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "browser.request"],
        methodResponses: {
          "browser.request": {
            cases: [
              responseCase("GET", "/tabs", {
                running: true,
                tabs: [{ ...target, tabId: "t1", title: "Example" }],
              }),
              responseCase("POST", "/screenshot", { ...target, path: "/proof/missing.png" }),
            ],
          },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await openChatSidePanelType(page, "Files");
      await openChatSidePanelType(page, "Browser");

      const panel = page.locator("section.bp");
      const alert = panel.getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toBe(
        "Browser request failed: Screenshot fetch failed (404).",
      );
      const readStream = () =>
        page.evaluate(
          () =>
            (window as Window & { openclawScreenshotProof?: ScreenshotProof })
              .openclawScreenshotProof,
        );
      await expect.poll(readStream).toEqual({
        cancelCount: 1,
        cancelResolvedCount: 1,
        fetchCount: 1,
        statuses: [404],
      });

      const requests = await gateway.getRequests("browser.request");
      const requestParams = requests.map(
        (request) => request.params as { method?: string; path?: string; body?: unknown },
      );
      expect(requestParams).toContainEqual({
        method: "GET",
        path: "/tabs",
        tabScope: { sessionKey: "agent:main:main", referencedTabs: [] },
      });
      expect(
        requestParams.filter((params) => params.method === "POST" && params.path === "/screenshot"),
      ).toEqual([
        {
          body: { targetId: "t1", type: "png" },
          method: "POST",
          path: "/screenshot",
          tabScope: { sessionKey: "agent:main:main" },
        },
      ]);
      expect(mediaRequest).toEqual({
        authorization: "Bearer e2e-device-token",
        source: "/proof/missing.png",
      });
    });
  });
});
