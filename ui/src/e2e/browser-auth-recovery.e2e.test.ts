import { createServer } from "node:http";
import path from "node:path";
import type { Route } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { buildControlUiCspHeader } from "../../../src/gateway/control-ui-csp.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { composerValue, fillComposer } from "../test-helpers/composer-editor.ts";
import {
  controlUiSessionUrl,
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const renewedCookie = "synthetic_app_session=renewed; Path=/; HttpOnly; SameSite=None; Secure";
let signInUrl: string;
let callbackUrl: string;
const forwardedCredentials: boolean[] = [];
// Redirected navigation requests are not intercepted again by Playwright.
// A real HTTP exchange proves browser cookie delivery across the two sites.
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
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  resources: {
    run: async () => {
      await new Promise<void>((resolve) => {
        accessServer.listen(0, "127.0.0.1", resolve);
      });
      const address = accessServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing synthetic Access listener");
      }
      signInUrl = `http://localhost:${address.port}/login`;
      callbackUrl = `http://127.0.0.1:${address.port}/authorized`;
    },
    close: async () => {
      accessServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        accessServer.close((error) => (error ? reject(error) : resolve()));
      });
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
          const artifactDir = suite.artifactDir;
          const expired = async (route: Route) =>
            !(await route.request().allHeaders()).cookie?.includes("synthetic_app_session=renewed");
          let metadataRequests = 0;
          let outgoingRequests = 0;
          let probes = 0;
          let renewals = 0;
          const mediaGate = createDeferred();
          const probeGate = createDeferred();
          const image = Buffer.from(
            await page.evaluate(() => {
              const canvas = document.createElement("canvas");
              canvas.width = 640;
              canvas.height = 320;
              const drawing = canvas.getContext("2d")!;
              drawing.fillStyle = "#e5f6ee";
              drawing.fillRect(0, 0, 640, 320);
              drawing.fillStyle = "#196c52";
              drawing.font = "bold 32px sans-serif";
              drawing.fillText("Loaded", 246, 160);
              drawing.font = "22px sans-serif";
              drawing.fillText("Synthetic image", 238, 193);
              return canvas.toDataURL("image/png").split(",")[1]!;
            }),
            "base64",
          );
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          const gateway = await installMockGateway(page, {
            deviceToken: "synthetic-recovery-device-token",
            historyMessages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    url: "media://inbound/sign-in-proof.png",
                    alt: "Synthetic attachment",
                  },
                  {
                    type: "image",
                    url: "media://inbound/second-sign-in-proof.png",
                    alt: "Second synthetic attachment",
                  },
                  { type: "text", text: "Please compare these two synthetic screenshots." },
                ],
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "image",
                    url: "/api/chat/media/outgoing/agent%3Amain%3Amain/sign-in-proof/full",
                    alt: "Synthetic generated image",
                    mimeType: "image/png",
                    width: 640,
                    height: 320,
                  },
                  {
                    type: "text",
                    text: "The conversation stays connected while website access is renewed.",
                  },
                ],
              },
            ],
          });
          const routeProbe = async (route: Route) => {
            const request = route.request();
            const frameNavigation =
              request.isNavigationRequest() && request.frame() !== page.mainFrame();
            if (request.method() !== "HEAD" && !frameNavigation) {
              await route.fallback();
              return;
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
                ? { status: 302, headers: { location: signInUrl } }
                : request.headers().authorization === "Bearer synthetic-recovery-device-token"
                  ? { status: 200, contentType: "application/json", body: "" }
                  : { status: 401 },
            );
          };
          await context.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, routeProbe);
          await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, routeProbe);
          // Cross-origin redirects really pass through Chromium's fetch/CORS
          // behavior; the fixture never calls the recovery owner's event API.
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
          await context.route("**/api/chat/media/outgoing/**", async (route) => {
            outgoingRequests += 1;
            await mediaGate.promise;
            await route.fulfill(
              (await expired(route))
                ? { status: 302, headers: { location: signInUrl } }
                : { contentType: "image/png", body: image },
            );
          });
          await context.route("**/__openclaw__/assistant-media?**", async (route) => {
            const metadata = new URL(route.request().url()).searchParams.get("meta") === "1";
            if (metadata) {
              metadataRequests += 1;
            }
            await mediaGate.promise;
            if (await expired(route)) {
              await route.fulfill({
                status: 302,
                headers: { location: signInUrl },
              });
            } else if (metadata) {
              await route.fulfill({
                contentType: "application/json",
                body: JSON.stringify({ available: true, width: 640, height: 320 }),
              });
            } else {
              await route.fulfill({ contentType: "image/png", body: image });
            }
          });
          const rootUrl = new URL("/", suite.server.baseUrl).href;
          await context.route(rootUrl, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: '<!doctype html><title>Synthetic sign-in</title><h1>Website sign-in</h1><a href="/sign-in-complete">Complete sign-in</a>',
            }),
          );
          await context.route(new URL("/sign-in-complete", rootUrl).href, async (route) => {
            await route.fulfill({
              contentType: "text/html",
              headers: { "set-cookie": renewedCookie },
              body: "Signed in. Return to your conversation.",
            });
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          // Apply the shipped policy after Vite boot; renewal must work without
          // adding the identity provider to connect-src or enabling frame scripts.
          await page.evaluate((policy) => {
            const meta = document.createElement("meta");
            meta.httpEquiv = "Content-Security-Policy";
            meta.content = policy;
            document.head.append(meta);
          }, buildControlUiCspHeader());
          const composer = page.locator(".agent-chat__composer-combobox openclaw-composer-editor");
          const draft = "Keep this unsent draft while I sign in.";
          await fillComposer(composer, draft);
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
          expect(initialConnects).toBe(1);
          mediaGate.resolve();
          await page.getByRole("button", { name: "Retry", exact: true }).first().waitFor();
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "01-image-unavailable.png"),
          });
          probeGate.resolve();
          const modal = page
            .locator("openclaw-modal-dialog")
            .filter({ hasText: "Sign in to continue loading content" });
          if (renewal === "interactive") {
            await modal.waitFor();
            expect(await modal.count()).toBe(1);
            expect(probes).toBe(2);
            expect(metadataRequests).toBe(2);
            expect(await composerValue(composer)).toBe(draft);
            expect(page.url()).toBe(originalUrl);
            expect(await gateway.getRequests("connect")).toHaveLength(initialConnects);
            const expectDialogToFit = async () => {
              expect(
                await modal.evaluate((element) => {
                  const card = element.querySelector(".exec-approval-card")!;
                  const description = element.querySelector(".exec-approval-sub")!;
                  const bounds = card.getBoundingClientRect();
                  return {
                    descriptionOverflows: description.scrollWidth > description.clientWidth,
                    outsideViewport: bounds.left < 0 || bounds.right > window.innerWidth,
                  };
                }),
              ).toEqual({ descriptionOverflows: false, outsideViewport: false });
            };
            await expectDialogToFit();
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, "02-sign-in-required.png"),
            });
            await page.setViewportSize({ width: 390, height: 844 });
            await expectDialogToFit();
            await page.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, "03-sign-in-required-mobile.png"),
            });
            await page.setViewportSize({ width: 1280, height: 900 });
            // Let the generated preview exhaust its single automatic retry before
            // signing in; restoration must wake that existing failed resource.
            await expect.poll(() => outgoingRequests).toBe(2);
            await expect.poll(() => metadataRequests).toBe(4);
            const popupPromise = context.waitForEvent("page");
            await modal.getByRole("button", { name: "Sign in", exact: true }).click();
            const signIn = await popupPromise;
            await signIn.waitForURL(rootUrl);
            expect(await signIn.evaluate(() => window.opener === null)).toBe(true);
            await signIn.getByRole("link", { name: "Complete sign-in" }).click();
            await signIn.getByText("Signed in. Return to your conversation.").waitFor();
            // Playwright emulates every document as focused; the explicit action
            // exercises browser recovery without inventing a foreground event.
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
          expect(await composerValue(composer)).toBe(draft);
          expect(page.url()).toBe(originalUrl);
          expect(await gateway.getRequests("connect")).toHaveLength(initialConnects);
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "04-content-recovered.png"),
          });
          await composer.press("Enter");
          const sent = await gateway.waitForRequest("chat.send");
          expect(sent.params).toMatchObject({ message: draft, sessionKey: "agent:main:main" });
        },
      );
    },
  );
});
