import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import type { Frame } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { buildBoardWidgetSandboxPath } from "../../../src/gateway/board-sandbox.js";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeBoardTestServer, createBoardE2eSuite } from "./board-browser.test-support.ts";

const sessionKey = "agent:main:board-a2ui";
const bundleDirectory = path.resolve(
  process.env.OPENCLAW_A2UI_BUNDLE_DIR?.trim() || "extensions/canvas/src/host/a2ui",
);
const bundleFiles = {
  "v0.8": "a2ui.bundle.js",
  "v0.9": "a2ui-v0.9.bundle.js",
} as const;
const basicCatalog = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

let rendererServer: HttpServer;
let rendererOrigin: string;
type Protocol = keyof typeof bundleFiles;

function textComponent(version: Protocol, id: string, text: string) {
  return version === "v0.8"
    ? { id, component: { Text: { text: { literalString: text } } } }
    : { id, component: "Text", text };
}

function applyMessages(frame: Frame, messages: unknown[]) {
  return frame.evaluate(
    (updates) => Reflect.get(globalThis, "openclawA2UI").applyMessages(updates),
    messages,
  );
}

function refreshButton(context: Record<string, string> = {}) {
  return {
    id: "action",
    component: "Button",
    child: "action-label",
    variant: "primary",
    action: { event: { name: "refresh", context } },
  };
}

function updateComponents(version: Protocol, components: unknown[]) {
  const update = { surfaceId: "main", components };
  return version === "v0.8" ? { surfaceUpdate: update } : { version, updateComponents: update };
}

function buildInitialMessages(version: Protocol) {
  const components = [
    version === "v0.8"
      ? { id: "root", component: { Column: { children: { explicitList: ["title", "action"] } } } }
      : { id: "root", component: "Column", children: ["title", "action"] },
    textComponent(version, "title", "A2UI board widget"),
    version === "v0.8"
      ? {
          id: "action",
          component: {
            Button: { child: "action-label", action: { name: "refresh", context: [] } },
          },
        }
      : refreshButton(),
    textComponent(version, "action-label", "Refresh data"),
  ];
  const update = updateComponents(version, components);
  return version === "v0.8"
    ? [update, { beginRendering: { surfaceId: "main", root: "root" } }]
    : [{ version, createSurface: { surfaceId: "main", catalogId: basicCatalog } }, update];
}

const suite = createBoardE2eSuite("Control UI dashboard A2UI", {
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  beforeStart: async () => {
    if (!process.env.OPENCLAW_A2UI_BUNDLE_DIR?.trim()) {
      execFileSync(process.execPath, ["--import", "./scripts/tsx.mjs", "scripts/bundle-a2ui.mts"], {
        cwd: process.cwd(),
        stdio: "inherit",
      });
    }
    const rendererBundles = new Map<string, Buffer>(
      await Promise.all(
        Object.values(bundleFiles).map(
          async (file) => [file, await readFile(path.join(bundleDirectory, file))] as const,
        ),
      ),
    );
    rendererServer = createServer((request, response) => {
      const bundle = rendererBundles.get(
        path.posix.basename(new URL(request.url ?? "/", "http://localhost").pathname),
      );
      response.writeHead(
        bundle ? 200 : 404,
        bundle ? { "Content-Type": "text/javascript; charset=utf-8" } : {},
      );
      response.end(bundle ?? "not found");
    });
    rendererServer.listen(0, "127.0.0.1");
    await once(rendererServer, "listening");
    const rendererAddress = rendererServer.address();
    if (!rendererAddress || typeof rendererAddress === "string") {
      throw new Error("A2UI renderer server did not bind");
    }
    rendererOrigin = `http://127.0.0.1:${rendererAddress.port}`;
  },
  afterSandboxClose: () => closeBoardTestServer(rendererServer),
});
suite.define(() => {
  it("sends each v0.8 action once after the host reconnects", async () => {
    const page = await suite.newPage();
    await page.addScriptTag({
      path: path.join(bundleDirectory, bundleFiles["v0.8"]),
      type: "module",
    });
    const result = await page.evaluate(async () => {
      await customElements.whenDefined("openclaw-a2ui-host");
      const emitted: unknown[] = [];
      Reflect.set(globalThis, "openclaw", {
        state: {
          emit(payload: unknown) {
            emitted.push(payload);
            return Promise.resolve();
          },
        },
      });
      const host = document.createElement("openclaw-a2ui-host");
      const sendAction = () =>
        host.dispatchEvent(
          new CustomEvent("a2uiaction", {
            detail: {
              eventType: "a2ui.action",
              sourceComponentId: "refresh-button",
              action: { name: "refresh" },
            },
          }),
        );
      document.body.append(host);
      sendAction();
      const connectedCount = emitted.length;
      emitted.length = 0;
      host.remove();
      document.body.append(host);
      sendAction();
      host.remove();
      return { connectedCount, reconnected: emitted };
    });
    expect(result).toMatchObject({
      connectedCount: 1,
      reconnected: [
        {
          eventType: "a2ui.action",
          action: { name: "refresh", surfaceId: "main", sourceComponentId: "refresh-button" },
        },
      ],
    });
  });

  for (const { version, colorScheme, rejectsAction, name } of [
    ...(["v0.8", "v0.9"] as const).flatMap((protocol) =>
      (["dark", "light"] as const).map((theme) => ({
        version: protocol,
        colorScheme: theme,
        rejectsAction: false,
        name: `renders a ${protocol} widget with the ${theme} scrollbar theme`,
      })),
    ),
    {
      version: "v0.9" as const,
      colorScheme: "light" as const,
      rejectsAction: true,
      name: "shows rejected v0.9 actions and clears the widget on reset",
    },
  ]) {
    it(name, async () => {
      const page = await suite.newPage({
        colorScheme,
        permissions: ["local-network-access"],
        viewport: { width: 1280, height: 800 },
      });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        if (pageErrors.length < 8) {
          pageErrors.push(error.message.slice(0, 512));
        }
      });
      const origin = new URL(suite.baseUrl).origin;
      const rendererUrl = `${rendererOrigin}/__openclaw__/cap/canvas-proof/__openclaw__/a2ui/${bundleFiles[version]}`;
      const messages = buildInitialMessages(version);
      const boot = JSON.stringify({ messages, actionTier: "state" }).replaceAll("<", "\\u003c");
      const documentHtml = buildWidgetDocument(
        "A2UI controls",
        `<script>globalThis.openclawA2UIBoot=${boot};</script><style>html,body{height:100%;background:var(--surface)}body{min-height:2400px}openclaw-a2ui-host{display:block;height:100%}</style><openclaw-a2ui-host></openclaw-a2ui-host><script src="${rendererUrl}"></script>`,
        { scriptOrigins: [rendererOrigin] },
      );
      const frameUrl = `${origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/a2ui-controls/index.html?bt=ticket`;
      await page.route("**/__openclaw__/board/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: documentHtml }),
      );
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.event", "board.get", "chat.metadata", "chat.startup"],
        methodResponses: {
          "board.get": {
            sessionKey,
            revision: 1,
            tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
            widgets: [
              {
                name: "a2ui-controls",
                tabId: "main",
                title: "A2UI controls",
                contentKind: "plugin",
                pluginKind: "canvas:a2ui",
                kindLabel: "A2UI",
                sizeW: 8,
                sizeH: 5,
                heightMode: "fixed",
                position: 0,
                grantState: "none",
                revision: 1,
                instanceId: "a2ui-instance",
                frameUrl,
                viewTicket: "ticket",
                viewTicketTtlMs: 1_200_000,
                viewGeneration: "0123456789abcdef0123456789abcdef",
                sandboxUrl: buildBoardWidgetSandboxPath({
                  grantState: "none",
                  resourceOrigins: [rendererOrigin],
                }),
                sandboxPort: suite.sandboxPort,
              },
            ],
          },
          "board.event": { ok: true, appended: true },
        },
      });

      await suite.openDashboard(page, sessionKey);
      const outer = page.locator(".board-widget__frame");
      await outer.waitFor();
      const outerFrame = await outer.elementHandle().then((handle) => handle?.contentFrame());
      await expect
        .poll(
          () =>
            outerFrame
              ?.childFrames()[0]
              ?.evaluate(() =>
                Boolean(
                  customElements.get("openclaw-a2ui-host") &&
                  Reflect.get(globalThis, "openclawA2UI"),
                ),
              )
              .catch(() => false) ?? false,
          { timeout: 30_000 },
        )
        .toBe(true);
      const widgetFrame = outerFrame!.childFrames()[0]!;
      await widgetFrame.getByText("A2UI board widget").waitFor();
      await expect
        .poll(() => outer.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      expect(await outer.getAttribute("inert")).toBeNull();
      if (rejectsAction) {
        await applyMessages(widgetFrame, [
          updateComponents("v0.9", [refreshButton({ diagnostic: "x".repeat(8193) })]),
        ]);
        await clickBoardWidgetControl(page, widgetFrame.getByText("Refresh data"));
        await expect
          .poll(() => widgetFrame.getByRole("alert").allTextContents())
          .toEqual(["widget state payload exceeds 8192 UTF-8 bytes"]);
        expect(await widgetFrame.getByRole("alert").isVisible()).toBe(true);
        expect(await gateway.getRequests("board.event")).toHaveLength(0);
        expect(pageErrors).toEqual([]);

        await widgetFrame.evaluate(() => Reflect.get(globalThis, "openclawA2UI").reset());
        await expect.poll(() => widgetFrame.getByRole("alert").count()).toBe(0);
        await expect.poll(() => widgetFrame.locator("a2ui-surface").count()).toBe(0);
        await applyMessages(widgetFrame, messages);
        await widgetFrame.getByText("A2UI board widget").waitFor();
      }
      await clickBoardWidgetControl(page, widgetFrame.getByText("Refresh data"));
      await expect.poll(async () => (await gateway.getRequests("board.event")).length).toBe(1);
      expect((await gateway.getRequests("board.event"))[0]?.params).toMatchObject({
        ticket: "ticket",
        payload: {
          eventType: "a2ui.action",
          action: { name: "refresh", surfaceId: "main", sourceComponentId: "action" },
        },
      });
      if (rejectsAction) {
        expect(await widgetFrame.getByRole("alert").count()).toBe(0);
        expect(pageErrors).toEqual([]);
        return;
      }
      const surface = await widgetFrame.locator("a2ui-surface").elementHandle();
      expect(surface).not.toBeNull();
      await applyMessages(widgetFrame, [
        updateComponents(version, [textComponent(version, "title", "A2UI board widget updated")]),
      ]);
      await widgetFrame.getByText("A2UI board widget updated", { exact: true }).waitFor();
      expect(
        await widgetFrame
          .locator("a2ui-surface")
          .evaluate((element, previousSurface) => element === previousSurface, surface),
      ).toBe(true);
      await surface?.dispose();
      await page.mouse.move(40, 40);

      const scrollbar = await widgetFrame.evaluate(() => {
        const root = document.documentElement;
        const probe = document.createElement("div");
        probe.style.background = "var(--scrollbar-thumb)";
        document.body.append(probe);
        const expectedThumb = getComputedStyle(probe).backgroundColor;
        probe.style.background = "var(--scrollbar-thumb-hover)";
        const expectedThumbHover = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const styles = getComputedStyle(root);
        return {
          background: getComputedStyle(root, "::-webkit-scrollbar").backgroundColor,
          colorScheme: styles.colorScheme,
          expectedBackground: getComputedStyle(document.body).backgroundColor,
          expectedThumb,
          expectedThumbHover,
          ratio: root.clientHeight / root.scrollHeight,
          size: styles.getPropertyValue("--scrollbar-size"),
          thumbBackground: getComputedStyle(root, "::-webkit-scrollbar-thumb").backgroundColor,
          trackBackground: getComputedStyle(root, "::-webkit-scrollbar-track").backgroundColor,
          width: getComputedStyle(root, "::-webkit-scrollbar").width,
        };
      });
      expect(scrollbar).toMatchObject({
        colorScheme,
        expectedBackground: expect.any(String),
        expectedThumb: expect.not.stringMatching(/^(?:rgba\(0, 0, 0, 0\)|transparent)$/),
        expectedThumbHover: expect.not.stringMatching(/^(?:rgba\(0, 0, 0, 0\)|transparent)$/),
        size: "12px",
        trackBackground: "rgba(0, 0, 0, 0)",
        width: "12px",
      });
      expect(scrollbar.background).toBe(scrollbar.expectedBackground);
      expect([scrollbar.expectedThumb, scrollbar.expectedThumbHover]).toContain(
        scrollbar.thumbBackground,
      );
      expect(scrollbar.ratio).toBeLessThan(0.2);
      expect(pageErrors).toEqual([]);
    });
  }
});
