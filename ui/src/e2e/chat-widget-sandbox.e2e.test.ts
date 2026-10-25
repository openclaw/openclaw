import { once } from "node:events";
// Real Chromium, HTTP authentication, and sandbox isolation around mocked Gateway data.
import { createServer, type Server } from "node:http";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { FrameLocator, Route } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { textMessage, timedText } from "./chat-flow-fixtures.test-support.ts";
import { board as createBoardSnapshot } from "./chat-layout-fixtures.test-support.ts";
import {
  installWidgetPromptDiagnostics,
  retainWidgetPromptFailure,
} from "./chat-widget-sandbox.diagnostics.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI authenticated widget sandbox",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:widget-sandbox-proof";
const documentId = "widget-sandbox-proof";
const documentPath = `/__openclaw__/canvas/documents/${documentId}/index.html`;
const widgetName = `canvas-${documentId}`;
const boardPath = `/__openclaw__/board/${encodeURIComponent(sessionKey)}/${widgetName}/index.html`;
const sourceAuthorization = "Bearer synthetic-widget-source-credential";

function widgetDocument(): string {
  return buildWidgetDocument(
    "Community pulse",
    `<style>.details{height:540px;padding-top:20px}</style>
    <h1>Community pulse</h1>
    <label>Local note<input aria-label="Local note" placeholder="State stays in this widget"></label>
    <button id="refresh">Refresh via chat</button><button id="details">Toggle details</button>
    <button id="data">Try dashboard data</button><button id="record">Record state</button>
    <button id="popup">Try native popup</button>
    <output id="popup-result" aria-label="Popup result"></output>
    <output id="result" aria-label="Widget result">Ready</output>
    <div id="extra" class="details" hidden>Additional community details</div>
    <script>
      (()=>{
        const nativeOpen=window.open;
        document.querySelector('#popup').onclick=()=>{
          document.querySelector('#popup-result').textContent=
            !navigator.userActivation.isActive?'No user activation':
              nativeOpen.call(window,'about:blank','_blank')===null?'Popup blocked':'Popup opened';
        };
      })();
    </script>
    <script>
      function open(){const extra=document.querySelector('#extra');extra.hidden=!extra.hidden;}
      document.querySelector('#refresh').onclick=()=>window.openclaw.prompt.send('Refresh the synthetic dashboard');
      document.querySelector('#details').onclick=open;
      document.querySelector('#data').onclick=async()=>{try{await window.openclaw.data.read('private-dashboard');
        document.querySelector('#result').textContent='Unexpected data access';}
        catch{document.querySelector('#result').textContent='Dashboard data is unavailable in chat';}};
      document.querySelector('#record').onclick=async()=>{await window.openclaw.state.emit({clicked:true});
        document.querySelector('#result').textContent='State recorded';};
    </script>`,
  );
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Widget proof server did not bind a TCP port");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startProtectedSource(html: string) {
  const sourceDestinations: string[] = [];
  const boardRequests: string[] = [];
  const omittedHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "transfer-encoding",
  ]);
  const server = createServer((request, response) => {
    void (async () => {
      const respond = (status: number, body: string, headers: Record<string, string> = {}) => {
        response.writeHead(status, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          ...headers,
        });
        response.end(body);
      };
      const url = new URL(request.url ?? "/", suite.server.baseUrl);
      if (url.pathname === documentPath) {
        const authorized = request.headers.authorization === sourceAuthorization;
        const destination = request.headers["sec-fetch-dest"];
        if (typeof destination === "string") {
          sourceDestinations.push(destination);
        }
        respond(
          authorized ? 200 : 302,
          authorized ? html : "Authentication required",
          authorized ? {} : { Location: "/widget-login" },
        );
        return;
      }
      if (url.pathname === "/widget-login") {
        respond(
          200,
          "<!doctype html><title>Synthetic sign-in</title>Sign in to view this widget.",
          {
            "Content-Security-Policy": "frame-ancestors 'none'",
            "X-Frame-Options": "DENY",
          },
        );
        return;
      }
      if (url.pathname === boardPath) {
        const ticket = url.searchParams.get("bt") ?? "";
        boardRequests.push(ticket);
        const authorized = ticket === "ticket" || ticket === "renewed-ticket";
        respond(authorized ? 200 : 401, authorized ? html : "Invalid widget ticket");
        return;
      }
      const upstream = await fetch(url, { headers: { Accept: request.headers.accept ?? "*/*" } });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!omittedHeaders.has(name)) {
          response.setHeader(name, value);
        }
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (upstream.headers.get("content-type")?.startsWith("text/html")) {
        response.setHeader(
          "Content-Security-Policy",
          buildControlUiCspHeader({
            inlineScriptHashes: computeInlineScriptHashes(body.toString("utf8")),
          }),
        );
      }
      response.end(body);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
  });
  const port = await listen(server);
  return { server, baseUrl: `http://127.0.0.1:${port}/`, sourceDestinations, boardRequests };
}

suite.define(() => {
  const sandboxDocument = useCanvasSandboxFixture();
  it("loads protected widgets in chat and preserves isolated interactive frames", async () => {
    const html = widgetDocument();
    const { sandboxUrl, sandboxPort } = sandboxDocument(html);
    const proxy = await startProtectedSource(html);
    const snapshot = createBoardSnapshot(sessionKey, [
      createBoardWidget({
        name: widgetName,
        title: "Community pulse",
        sizeW: 12,
        sizeH: 5,
        frameUrl: `${new URL(proxy.baseUrl).origin}${boardPath}?bt=ticket`,
        viewTicket: "ticket",
        viewTicketTtlMs: 1_200_000,
        viewGeneration: "0123456789abcdef0123456789abcdef",
        sandboxUrl,
        sandboxPort,
      }),
    ]);
    try {
      const unauthenticated = await fetch(new URL(documentPath, proxy.baseUrl), {
        redirect: "manual",
      });
      expect(unauthenticated.status).toBe(302);
      const authenticated = await fetch(new URL(documentPath, proxy.baseUrl), {
        headers: { Authorization: sourceAuthorization },
      });
      expect(await authenticated.text()).toBe(html);

      let completed = false;
      await suite.withPage(
        {
          viewport: { width: 1600, height: 1000 },
          serviceWorkers: "block",
          permissions: ["local-network-access"],
        },
        async ({ page, context }) => {
          const click = (widget: FrameLocator, name: string) =>
            clickBoardWidgetControl(page, widget.getByRole("button", { name }));
          await installWidgetPromptDiagnostics(context);
          const storageKey = controlUiBundledSettingsStorageKey(proxy.baseUrl);
          await page.addInitScript(
            ({ key, session }) => {
              const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
              settings.boardSessionViews = { [session]: { activeTabId: "main" } };
              localStorage.setItem(key, JSON.stringify(settings));
            },
            { key: storageKey, session: sessionKey },
          );
          const gateway = await installMockGateway(page, {
            sessionKey,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "board.get",
              "board.event",
              "canvas.document.view",
            ],
            historyMessages: [
              timedText(
                "assistant",
                `[embed ref="${documentId}" title="Community pulse" height="460" /]`,
              ),
            ],
            methodResponses: {
              "canvas.document.view": { html, sandboxUrl, sandboxPort },
              "board.get": snapshot,
              "board.event": { ok: true, appended: true },
            },
          });
          const outer = page.locator(".chat-tool-card__preview-frame");
          const configReady = createDeferredCore();
          const holdConfig = async (route: Route) => {
            await configReady.promise;
            await route.fallback();
          };
          const configRoute = `**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;
          await page.route(configRoute, holdConfig);
          try {
            await page.goto(controlUiSessionUrl(proxy.baseUrl, sessionKey, "dashboard"));
            await outer.waitFor();
            // Chat can render before bootstrap resolves; strict mode must still authenticate.
            const strict = outer.contentFrame();
            await strict.getByRole("heading", { name: "Community pulse" }).waitFor();
            await expect
              .poll(() => strict.locator("body").evaluate(() => document.readyState))
              .toBe("complete");
            expect(await outer.getAttribute("sandbox")).toBe("");
            await strict.getByRole("button", { name: "Toggle details" }).click();
            expect(await strict.locator("#extra").isVisible()).toBe(false);
            await strict.getByRole("button", { name: "Refresh via chat" }).click();
            expect(await gateway.getRequests("chat.send")).toEqual([]);
            expect(proxy.sourceDestinations).toEqual([]);
          } finally {
            await page.unroute(configRoute, holdConfig);
            configReady.resolve();
          }
          const boardOuter = page.locator(".board-widget__frame");
          const board = boardOuter.contentFrame().frameLocator("iframe");
          await board.getByRole("heading", { name: "Community pulse" }).waitFor();
          const inline = outer.contentFrame().frameLocator("iframe");
          await inline.getByRole("heading", { name: "Community pulse" }).waitFor();
          expect(proxy.sourceDestinations).toEqual([]);
          expect((await gateway.getRequests("canvas.document.view"))[0]?.params).toEqual({
            docId: documentId,
          });
          expect(proxy.boardRequests).toEqual(["ticket"]);
          for (const widget of [inline, board]) {
            await click(widget, "Toggle details");
            await widget.getByText("Additional community details").waitFor();
            await click(widget, "Toggle details");
            await widget.getByText("Additional community details").waitFor({ state: "hidden" });
            await click(widget, "Try native popup");
            await widget.getByText("Popup blocked", { exact: true }).waitFor();
          }

          const isolation = await inline.locator("body").evaluate(() => {
            const denied = (read: () => unknown) => {
              try {
                read();
                return false;
              } catch {
                return true;
              }
            };
            return {
              topDom: denied(() => window.top?.document),
              wrapperDom: denied(() => window.parent.document),
              cookies: denied(() => document.cookie),
              localStorage: denied(() => window.localStorage),
            };
          });
          expect(isolation).toEqual({
            topDom: true,
            wrapperDom: true,
            cookies: true,
            localStorage: true,
          });
          await inline.getByRole("button", { name: "Try dashboard data" }).click();
          await inline.getByText("Dashboard data is unavailable in chat").waitFor();
          expect(await gateway.getRequests("board.data.read")).toEqual([]);

          const retainedFrame = await outer.elementHandle();
          const retainedBoardFrame = await boardOuter.elementHandle();
          const note = inline.getByRole("textbox", { name: "Local note" });
          const boardNote = board.getByRole("textbox", { name: "Local note" });
          const expectRetainedNote = async () => {
            expect(await retainedFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
            expect(await note.inputValue()).toBe("State survives rerenders");
          };
          await note.fill("State survives rerenders");
          await boardNote.fill("Dashboard state survives swaps");
          for (const region of ["main", "side"]) {
            await selectChatLayoutAction(page, /^Swap /);
            await expect
              .poll(() => page.locator('[data-panel-slot="dashboard"]').getAttribute("data-region"))
              .toBe(region);
            await expectRetainedNote();
            expect(await retainedBoardFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
            expect(await boardNote.inputValue()).toBe("Dashboard state survives swaps");
          }
          const originalHeight = (await outer.boundingBox())?.height ?? 0;
          await click(inline, "Toggle details");
          await expect
            .poll(async () => (await outer.boundingBox())?.height ?? 0)
            .toBeGreaterThan(originalHeight + 400);
          await expectRetainedNote();
          await click(inline, "Toggle details");

          await click(inline, "Refresh via chat");
          const sent = asRecord((await gateway.waitForRequest("chat.send")).params);
          expect(sent).toMatchObject({
            sessionKey,
            message: "Refresh the synthetic dashboard",
            idempotencyKey: expect.any(String),
          });
          const runId = String(sent.idempotencyKey);
          const paragraph = (hasText: RegExp) => page.getByRole("paragraph").filter({ hasText });
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            seq: 1,
            state: "delta",
            message: textMessage("assistant", "Refreshing community signals…"),
          });
          await paragraph(/^Refreshing community signals…$/u).waitFor();
          await gateway.emitChatFinal({
            sessionKey,
            runId,
            text: "Synthetic dashboard refreshed.",
          });
          await paragraph(/^Synthetic dashboard refreshed\.$/u).waitFor();
          await expectRetainedNote();
          expect(await gateway.getRequests("canvas.document.view")).toHaveLength(1);

          await click(board, "Record state");
          await board.getByText("State recorded", { exact: true }).waitFor();
          expect((await gateway.getRequests("board.event"))[0]?.params).toEqual({
            ticket: "ticket",
            payload: { clicked: true },
          });
          await page.emulateMedia({ colorScheme: "dark" });
          // A light proxy between dark documents paints an opaque UA canvas.
          for (const frame of [inline, outer.contentFrame(), board]) {
            await expect
              .poll(() =>
                frame.locator("html").evaluate((root) => getComputedStyle(root).colorScheme),
              )
              .toBe("dark");
          }
          expect(await note.inputValue()).toBe("State survives rerenders");
          // Saved HTML has no generated wrapper; the sandbox runtime owns shortcuts.
          await page.route(`${new URL(boardPath, proxy.baseUrl).href}?*`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><input aria-label="Saved dashboard note">
                <button onclick="parent.postMessage({type:'openclaw:widget-command-palette',
                  nonce:window.shortcutNonce||window.scrollNonce},'*');
                  parent.postMessage({type:'fixture-shortcut-attempted'},'*');">Attempt shortcut</button>
                <script>window.addEventListener('message',event=>{
                  if(event.data?.type==='openclaw:widget-board-host')window.scrollNonce=event.data.nonce;
                  if(event.data?.type==='openclaw:widget-shortcut-host')window.shortcutNonce=event.data.nonce;
                });</script>`,
            }),
          );
          await gateway.setMethodResponse("board.get", {
            ...snapshot,
            revision: 2,
            widgets: [{ ...snapshot.widgets[0], revision: 2 }],
          });
          await gateway.emitGatewayEvent("board.changed", { sessionKey });
          const savedNote = board.getByRole("textbox", { name: "Saved dashboard note" });
          await savedNote.fill("Saved draft");
          expect(
            await savedNote.evaluate((element) => {
              const event = new KeyboardEvent("keydown", {
                key: "k",
                code: "KeyK",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              });
              element.dispatchEvent(event);
              return event.defaultPrevented;
            }),
          ).toBe(false);
          const paletteInput = page.locator(".cmd-palette__input");
          for (const chord of ["ControlOrMeta+K", "ControlOrMeta+P", "ControlOrMeta+Shift+P"]) {
            await page.keyboard.press(chord);
            await paletteInput.waitFor();
            await page.keyboard.type("Settings");
            expect(await paletteInput.inputValue()).toBe("Settings");
            await page.keyboard.press("Escape");
            await paletteInput.waitFor({ state: "hidden" });
            await expect
              .poll(() =>
                savedNote.evaluate(
                  (element) => document.hasFocus() && document.activeElement === element,
                ),
              )
              .toBe(true);
          }
          await page.keyboard.type("!");
          expect(await savedNote.inputValue()).toBe("Saved draft!");
          expect(await savedNote.evaluate(() => Boolean(Reflect.get(window, "scrollNonce")))).toBe(
            false,
          );
          await page.evaluate(() => {
            window.addEventListener("message", function settle(event) {
              if (event.data?.type === "fixture-shortcut-attempted") {
                window.removeEventListener("message", settle);
                Reflect.set(window, "shortcutForgerySettled", true);
              }
            });
          });
          await board.getByRole("button", { name: "Attempt shortcut", exact: true }).click();
          await page.waitForFunction(() => Reflect.get(window, "shortcutForgerySettled") === true);
          expect(await paletteInput.count()).toBe(0);
          await savedNote.focus();
          await savedNote.evaluate(() => {
            Reflect.set(
              window,
              "keyboardDescriptors",
              Object.getOwnPropertyDescriptors(KeyboardEvent.prototype),
            );
            Object.defineProperties(KeyboardEvent.prototype, {
              key: { configurable: true, get: () => "k" },
              ctrlKey: { configurable: true, get: () => true },
              metaKey: { configurable: true, get: () => false },
            });
          });
          await page.keyboard.press("j");
          expect(await savedNote.inputValue()).toBe("Saved draft!j");
          expect(await paletteInput.count()).toBe(0);
          await savedNote.evaluate(() => {
            Object.defineProperties(
              KeyboardEvent.prototype,
              Reflect.get(window, "keyboardDescriptors"),
            );
          });
          completed = true;
        },
        async ({ page }) => {
          if (!completed) {
            await retainWidgetPromptFailure(page, suite.artifactDir);
          }
        },
      );
    } finally {
      await close(proxy.server);
    }
  });
});
