import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";

type NativeLinkPost = { type: string; url: string; target: string };

declare global {
  interface Window {
    nativeLinkProof?: {
      posts: NativeLinkPost[];
      windowOpenCalls: string[];
    };
  }
}

/** The isolated external context starts cold: its first Control UI RPC batch can
 *  queue behind the source page's gateway work under load, so the external ready
 *  wait gets a longer state-based budget than the shared 10s helper. */
async function waitForExternalGatewayReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } };
          })
        | null;
      return app?.runtime?.context?.gateway?.snapshot?.phase === "connected";
    },
    undefined,
    { timeout: 90_000 },
  );
}

const gatewayToken = "session-menu-native-bridge-proof";

const suite = createControlUiE2eSuite({
  name: "Control UI session menu native link bridge with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it(
    "hands session New window and New tab to the native link bridge instead of a popup",
    { timeout: 300_000 },
    async () => {
      const owner = await createOpenClawTestInstance({
        name: "session-menu-native-bridge",
        gatewayToken,
        config: { gateway: { controlUi: { enabled: false } } },
      });
      try {
        const config = JSON.parse(await readFile(owner.configPath, "utf8")) as Record<
          string,
          unknown
        >;
        await owner.state.writeConfig({
          ...config,
          agents: {
            defaults: {
              workspace: owner.state.workspaceDir,
              model: { primary: "openai/gpt-5.6-luna" },
            },
            entries: {
              main: { identity: { name: "Bridge Proof" } },
            },
          },
        });
        await owner.startGateway();

        const sessionKey = "agent:main:native-bridge-proof";
        const label = "Native bridge proof";
        const created = await owner.cli([
          "gateway",
          "call",
          "sessions.create",
          "--params",
          JSON.stringify({ key: sessionKey, agentId: "main", label }),
          "--json",
        ]);
        expect(created.code, created.stderr).toBe(0);
        const session = JSON.parse(created.stdout) as { ok: boolean; sessionId: string };
        expect(session.ok).toBe(true);
        const reply = "The native link bridge opens this session route.";
        await appendTranscriptMessage(
          { agentId: "main", sessionKey, sessionId: session.sessionId, env: owner.env },
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: reply }],
              timestamp: Date.now(),
            },
          },
        );

        const expectedSessionUrl = controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat");

        await suite.withPage(
          { locale: "en-US", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
          async ({ page }) => {
            // Stand in for the WKWebView host contract the macOS shell installs
            // before any page script runs: record openclawLink posts and observe
            // window.open reservations. Like the native receiver, the stub does
            // not open anything inside this browser; the posted destination is
            // verified below in an isolated context, the way an external default
            // browser receives the NSWorkspace.open handoff.
            await page.addInitScript(() => {
              const posts: Array<{ type: string; url: string; target: string }> = [];
              const windowOpenCalls: string[] = [];
              const open = window.open.bind(window);
              Object.defineProperty(window, "nativeLinkProof", {
                value: { posts, windowOpenCalls },
                configurable: true,
              });
              window.open = (...args: Parameters<typeof open>) => {
                windowOpenCalls.push(String(args[0] ?? ""));
                return open(...args);
              };
              Object.defineProperty(window, "webkit", {
                value: {
                  messageHandlers: {
                    openclawLink: {
                      postMessage(message: { type: string; url: string; target: string }) {
                        posts.push(message);
                      },
                    },
                  },
                },
                configurable: true,
              });
            });
            const url = new URL(expectedSessionUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${owner.port}`);
            url.hash = `token=${encodeURIComponent(gatewayToken)}`;
            expect((await page.goto(url.toString()))?.status()).toBe(200);
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor({ timeout: 15_000 });
            await confirmation
              .getByRole("button", { name: `Switch to 127.0.0.1:${owner.port}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            await page.getByText(reply, { exact: true }).waitFor();

            const activePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
            const menuTrigger = activePane.getByRole("button", { name: `Actions for ${label}` });
            await expect.poll(() => menuTrigger.getAttribute("aria-expanded")).toBe("false");

            const nativePosts = () => page.evaluate(() => window.nativeLinkProof?.posts ?? []);
            const windowOpenCalls = () =>
              page.evaluate(() => window.nativeLinkProof?.windowOpenCalls ?? []);

            const expectedPost = { type: "open-link", url: expectedSessionUrl, target: "external" };

            for (const action of ["New window", "New tab"] as const) {
              await menuTrigger.click();
              await openSessionMenuSubmenu(page, "Open in");
              await page.getByRole("menuitem", { name: action, exact: true }).click();

              // The action posts the final session URL to the native bridge...
              await expect
                .poll(async () => (await nativePosts()).at(-1), { timeout: 10_000 })
                .toEqual(expectedPost);
              // ...without reserving an about:blank popup or showing the
              // blocked-popup toast that a WKWebView host cannot satisfy.
              expect(await windowOpenCalls()).toEqual([]);
              expect(
                await page.getByText("Allow pop-ups for this site, then try again.").count(),
              ).toBe(0);
            }
            // Both actions handed the same session destination to the bridge.
            const posts = await nativePosts();
            expect(posts).toEqual([expectedPost, expectedPost]);

            // Verify the handoff destination the way an external default browser
            // receives it after NSWorkspace.open: a fresh isolated browser
            // context that shares no cookies, storage, or page state with the
            // source page. The external browser must sign in explicitly first —
            // the analog of a default browser that was previously paired — and
            // only then navigates to the posted URL verbatim, with no gatewayUrl
            // or credential parameters appended, so the rendered session must
            // come from the handed-off URL plus the external browser's own
            // independent sign-in state. A second, never-paired context below
            // loads the same posted URL and must be stopped at the login gate:
            // the handoff never grants the session to an unauthenticated
            // browser; that browser reaches an explicit sign-in surface instead.
            const postedUrl = posts.at(-1)!.url;
            const externalContext = await suite.newBrowserContext({
              locale: "en-US",
              viewport: { width: 1440, height: 900 },
              serviceWorkers: "block",
            });
            try {
              const externalPage = await externalContext.newPage();
              const signInUrl = new URL(expectedSessionUrl);
              signInUrl.searchParams.set("gatewayUrl", `ws://127.0.0.1:${owner.port}`);
              signInUrl.hash = `token=${encodeURIComponent(gatewayToken)}`;
              expect((await externalPage.goto(signInUrl.toString()))?.status()).toBe(200);
              const externalConfirmation = externalPage.locator(
                "openclaw-gateway-url-confirmation",
              );
              await externalConfirmation.waitFor({ timeout: 15_000 });
              await externalConfirmation
                .getByRole("button", { name: `Switch to 127.0.0.1:${owner.port}`, exact: true })
                .click();
              await waitForExternalGatewayReady(externalPage);

              // Navigate to the posted URL verbatim: no credentials appended.
              expect((await externalPage.goto(postedUrl))?.status()).toBe(200);
              await waitForExternalGatewayReady(externalPage);
              const expectedDestination = new URL(postedUrl).pathname + new URL(postedUrl).search;
              await expect
                .poll(
                  () => new URL(externalPage.url()).pathname + new URL(externalPage.url()).search,
                )
                .toBe(expectedDestination);
              await externalPage.getByText(reply, { exact: true }).waitFor({ timeout: 15_000 });
            } finally {
              await suite.closeBrowserContext(externalContext);
            }

            // The unauthenticated-browser case: a never-paired default browser
            // receiving the same posted URL verbatim does not see the session.
            // It lands on the Control UI login gate — the explicit sign-in
            // surface where the browser can pair with the gateway — and the
            // session transcript never renders there.
            const unpairedContext = await suite.newBrowserContext({
              locale: "en-US",
              viewport: { width: 1440, height: 900 },
              serviceWorkers: "block",
            });
            try {
              const unpairedPage = await unpairedContext.newPage();
              expect((await unpairedPage.goto(postedUrl))?.status()).toBe(200);
              const loginGate = unpairedPage.locator("openclaw-login-gate");
              await loginGate.waitFor({ timeout: 30_000 });
              expect(await unpairedPage.getByText(reply, { exact: true }).count()).toBe(0);
            } finally {
              await suite.closeBrowserContext(unpairedContext);
            }
          },
        );
      } finally {
        await owner.cleanup();
      }
    },
  );
});
