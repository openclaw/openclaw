import { createServer } from "node:http";
import type { Route } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { buildControlUiCspHeader } from "../../../src/gateway/control-ui-csp.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  controlUiSessionUrl,
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const renewedCookie = "synthetic_app_session=renewed; Path=/; HttpOnly; SameSite=None; Secure";
const image = createSolidPngBuffer(640, 320, { r: 229, g: 246, b: 238 });
const text = (value: string) => ({ type: "text", text: value });
const message = (role: "user" | "assistant", ...content: Record<string, unknown>[]) => ({
  role,
  content,
});
const imageContent = (url: string, alt: string, extra: Record<string, unknown> = {}) => ({
  type: "image",
  url,
  alt,
  ...extra,
});
let signInUrl: string;
let callbackUrl: string;
const forwardedCredentials: boolean[] = [];
// Redirects bypass Playwright interception; real HTTP proves cross-site cookie delivery.
const accessServer = createServer((request, response) => {
  forwardedCredentials.push(Boolean(request.headers.authorization));
  if (
    request.url === "/login" &&
    request.headers.cookie?.includes("synthetic_global_session=valid")
  ) {
    response.writeHead(302, { location: callbackUrl });
  } else if (request.url === "/authorized") {
    response.writeHead(302, { "set-cookie": renewedCookie, location: "/complete" });
  } else {
    response.writeHead(200, { "content-type": "text/html", "X-Frame-Options": "DENY" });
  }
  response.end("Synthetic access response");
});
const suite = createControlUiE2eSuite({
  name: "Browser sign-in recovery",
  resources: {
    run: async () => {
      await new Promise<void>((resolve) => {
        accessServer.listen(0, "127.0.0.1", resolve);
      });
      const address = accessServer.address();
      expect.assert(address && typeof address !== "string");
      signInUrl = `http://localhost:${address.port}/login`;
      callbackUrl = `http://127.0.0.1:${address.port}/authorized`;
    },
    close: async () => {
      accessServer.closeAllConnections();
      await accessServer[Symbol.asyncDispose]();
    },
  },
});

suite.define(() => {
  it.each([
    { serviceWorkers: "allow", renewal: "automatic" },
    { serviceWorkers: "block", renewal: "automatic" },
    { serviceWorkers: "allow", renewal: "interactive" },
    { serviceWorkers: "block", renewal: "interactive" },
  ] as const)(
    "recovers redirected images with $renewal renewal and service workers $serviceWorkers",
    async ({ serviceWorkers, renewal }) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers },
        async ({ context, page }) => {
          const expired = async (route: Route) =>
            !(await route.request().allHeaders()).cookie?.includes("synthetic_app_session=renewed");
          let metadataRequests = 0;
          let outgoingRequests = 0;
          let probes = 0;
          let renewals = 0;
          const mediaGate = createDeferred();
          const probeGate = createDeferred();
          const redirect = () => ({ status: 302, headers: { location: signInUrl } });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          const gateway = await installMockGateway(page, {
            deviceToken: "synthetic-recovery-device-token",
            historyMessages: [
              message(
                "user",
                imageContent("media://inbound/sign-in-proof.png", "Synthetic attachment"),
                imageContent(
                  "media://inbound/second-sign-in-proof.png",
                  "Second synthetic attachment",
                ),
                text("Please compare these two synthetic screenshots."),
              ),
              message(
                "assistant",
                imageContent(
                  "/api/chat/media/outgoing/agent%3Amain%3Amain/sign-in-proof/full",
                  "Synthetic generated image",
                  { mimeType: "image/png", width: 640, height: 320 },
                ),
                text("The conversation stays connected while website access is renewed."),
              ),
            ],
          });
          const routeProbe = async (route: Route) => {
            const request = route.request();
            const frameNavigation =
              request.isNavigationRequest() && request.frame() !== page.mainFrame();
            if (request.method() !== "HEAD" && !frameNavigation) {
              return route.fallback();
            }
            if (frameNavigation) {
              renewals += 1;
              expect(request.headers().authorization).toBeUndefined();
              expect(request.headers().referer).toBeUndefined();
            } else {
              probes += 1;
            }
            await probeGate.promise;
            await route.fulfill(
              (await expired(route))
                ? redirect()
                : request.headers().authorization === "Bearer synthetic-recovery-device-token"
                  ? { status: 200, contentType: "application/json", body: "" }
                  : { status: 401 },
            );
          };
          await context.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, routeProbe);
          await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, routeProbe);
          if (renewal === "automatic") {
            await context.addCookies([
              {
                name: "synthetic_global_session",
                value: "valid",
                domain: "localhost",
                path: "/",
                httpOnly: true,
                secure: true,
                sameSite: "None",
              },
            ]);
          }
          const serveMedia = async (route: Route, metadata: boolean) => {
            await mediaGate.promise;
            await route.fulfill(
              (await expired(route))
                ? redirect()
                : metadata
                  ? {
                      contentType: "application/json",
                      body: JSON.stringify({ available: true, width: 640, height: 320 }),
                    }
                  : { contentType: "image/png", body: image },
            );
          };
          await context.route("**/api/chat/media/outgoing/**", (route) => {
            outgoingRequests += 1;
            return serveMedia(route, false);
          });
          await context.route("**/__openclaw__/assistant-media?**", (route) => {
            const metadata = new URL(route.request().url()).searchParams.get("meta") === "1";
            metadataRequests += Number(metadata);
            return serveMedia(route, metadata);
          });
          const rootUrl = new URL("/", suite.server.baseUrl).href;
          const routeHtml = (url: string, body: string, headers?: Record<string, string>) =>
            context.route(url, (route) =>
              route.fulfill({ contentType: "text/html", body, headers }),
            );
          await routeHtml(rootUrl, '<a href="/sign-in-complete">Complete sign-in</a>');
          await routeHtml(
            new URL("/sign-in-complete", rootUrl).href,
            "Signed in. Return to your conversation.",
            { "set-cookie": renewedCookie },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          // Apply shipped CSP after UI boot without relaxing frames or IdP access.
          await page.evaluate((policy) => {
            const meta = document.createElement("meta");
            meta.httpEquiv = "Content-Security-Policy";
            meta.content = policy;
            document.head.append(meta);
          }, buildControlUiCspHeader());
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          const draft = "Keep this unsent draft while I sign in.";
          await composer.fill(draft);
          if (serviceWorkers === "allow") {
            await page.evaluate(async () => {
              await navigator.serviceWorker.register("/sw.js?v=sign-in-proof");
              await navigator.serviceWorker.ready;
            });
            await page.waitForFunction(
              () => navigator.serviceWorker.controller?.state === "activated",
            );
          }
          const originalUrl = page.url();
          const initialConnects = (await gateway.getRequests("connect")).length;
          const expectConversationRetained = async () => {
            expect(await composer.inputValue()).toBe(draft);
            expect(page.url()).toBe(originalUrl);
            expect(await gateway.getRequests("connect")).toHaveLength(initialConnects);
          };
          expect(initialConnects).toBe(1);
          mediaGate.resolve();
          await page.getByRole("button", { name: "Retry", exact: true }).first().waitFor();
          probeGate.resolve();
          const modal = page
            .locator("openclaw-modal-dialog")
            .filter({ hasText: "Sign in to continue loading content" });
          if (renewal === "interactive") {
            await modal.waitFor();
            expect(await modal.count()).toBe(1);
            expect({ probes, metadataRequests }).toEqual({ probes: 2, metadataRequests: 2 });
            await expectConversationRetained();
            const expectDialogToFit = async () => {
              expect(
                await modal.evaluate((element) => {
                  const card = element.querySelector(".exec-approval-card")!;
                  const description = element.querySelector(".exec-approval-sub")!;
                  const bounds = card.getBoundingClientRect();
                  return [
                    description.scrollWidth > description.clientWidth,
                    bounds.left < 0 || bounds.right > window.innerWidth,
                  ];
                }),
              ).toEqual([false, false]);
            };
            await expectDialogToFit();
            await page.setViewportSize({ width: 390, height: 844 });
            await expectDialogToFit();
            await page.setViewportSize({ width: 1280, height: 900 });
            // Exhaust the automatic retry; restoration must wake the failed resource.
            await expect.poll(() => outgoingRequests).toBe(2);
            await expect.poll(() => metadataRequests).toBe(4);
            const popupPromise = context.waitForEvent("page");
            await modal.getByRole("button", { name: "Sign in", exact: true }).click();
            const signIn = await popupPromise;
            await signIn.waitForURL(rootUrl);
            expect(await signIn.evaluate(() => window.opener === null)).toBe(true);
            await signIn.getByRole("link", { name: "Complete sign-in" }).click();
            await signIn.getByText("Signed in. Return to your conversation.").waitFor();
            // Playwright focuses every document; Check again exercises real recovery.
            await modal.getByRole("button", { name: "Check again", exact: true }).click();
            await modal.waitFor({ state: "detached" });
          }
          const images = page.locator("img.chat-message-image");
          await expect.poll(() => images.count()).toBe(3);
          await images.evaluateAll(async (elements) => {
            await Promise.all(elements.map((element) => (element as HTMLImageElement).decode()));
          });
          expect(
            await images.evaluateAll((elements) =>
              elements.map((element) => (element as HTMLImageElement).naturalWidth),
            ),
          ).toEqual([640, 640, 640]);
          expect(await modal.count()).toBe(0);
          expect(renewals).toBe(1);
          expect(forwardedCredentials).not.toContain(true);
          expect(await page.locator("iframe").count()).toBe(0);
          expect(context.pages()).toHaveLength(renewal === "automatic" ? 1 : 2);
          await expectConversationRetained();
          await composer.press("Enter");
          const sent = await gateway.waitForRequest("chat.send");
          expect(sent.params).toMatchObject({ message: draft, sessionKey: "agent:main:main" });
        },
      );
    },
  );
});
