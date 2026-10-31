import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { expect, it } from "vitest";
import { buildControlUiCspHeader } from "../../../src/gateway/control-ui-csp.js";
import { resolvePlaywrightChromiumExecutablePath } from "../test-helpers/control-ui-e2e.ts";
import { buildWidgetInputShell, parseWidgetInputDocument } from "./widget-input-document.ts";

it("grows inert HTML/SVG under the Control UI HTTP policy and blocks generated resources", async () => {
  const runtime = await readFile(path.join(import.meta.dirname, "widget-input-runtime.js"));
  let assetRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/runtime.js") {
      assetRequests += 1;
      response.writeHead(200, { "Content-Type": "text/javascript" }).end(runtime);
    } else if (request.url === "/") {
      response
        .writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": buildControlUiCspHeader(),
        })
        .end('<iframe sandbox="allow-scripts" style="height:500px;width:800px"></iframe>');
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test server address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    const page = await browser.newPage();
    const requests: string[] = [];
    const failures = new Map<string, string | undefined>();
    page.on("requestfailed", (request) => {
      if (request.url().startsWith("https://example.invalid/")) {
        failures.set(request.url(), request.failure()?.errorText);
      }
    });
    page.on("request", (request) => {
      if (request.url().startsWith("https://example.invalid/")) {
        requests.push(request.url());
      }
    });
    await page.goto(origin);
    await page.locator("iframe").evaluate(
      (frame: HTMLIFrameElement, shell) => {
        frame.srcdoc = shell;
      },
      buildWidgetInputShell("test-nonce-12345678", `${origin}/runtime.js`),
    );
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (!frame) {
      throw new Error("Missing isolated frame");
    }
    await frame.locator("body > div").waitFor({ state: "attached" });
    const update = async (html: string) => {
      await page
        .locator("iframe")
        .evaluate(
          (element: HTMLIFrameElement, nodes) =>
            element.contentWindow?.postMessage({ type: "openclaw:widget-input", nodes }, "*"),
          parseWidgetInputDocument(html),
        );
    };
    await page.evaluate(() => {
      window.addEventListener("message", (event) => {
        if (event.data?.type === "openclaw:widget-size") {
          Reflect.set(window, "inputHeight", event.data.height);
        }
      });
    });
    await update('<svg viewBox="0 0 100 30"><circle cx="15" cy="15" r="10"/></svg>');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "inputHeight")))
      .toBeGreaterThan(0);
    const first =
      '<section id="stable"><h2>Morning survey</h2><p hidden>Unavailable fallback</p><p>Café 雪 🦀';
    await update(first);
    await frame.getByText("Café 雪 🦀", { exact: true }).waitFor();
    expect(await frame.getByText("Unavailable fallback", { exact: true }).isVisible()).toBe(false);
    const original = await frame.locator("#stable").elementHandle();
    await update(
      first +
        '</p><svg viewBox="0 0 100 30"><style>@import "https://example.invalid/import.css";.survey-dot{fill:rgb(255,0,0)}</style><circle id="dot" class="survey-dot" cx="15" cy="15" r="10"/></svg><style>section{background-image:url(https://example.invalid/image)}</style><script>globalThis.widgetRan=true;fetch("https://example.invalid/script")</script><a href="javascript:globalThis.widgetRan=true" onclick="globalThis.widgetRan=true">Link</a><form action="https://example.invalid/form"><input autofocus></form><svg><image href="https://example.invalid/svg"/><use href="https://example.invalid/ref#x"/></svg><button onclick="globalThis.widgetRan=true">Action</button></section>',
    );
    await frame.locator("#dot").waitFor({ state: "attached" });
    expect(
      await frame.locator("#stable").evaluate((element, old) => element === old, original),
    ).toBe(true);
    expect(await frame.locator("#dot").evaluate((element) => element.namespaceURI)).toBe(
      "http://www.w3.org/2000/svg",
    );
    expect(await frame.locator("#dot").evaluate((element) => getComputedStyle(element).fill)).toBe(
      "rgb(255, 0, 0)",
    );
    expect(await frame.locator("a").getAttribute("href")).toBeNull();
    expect(await frame.locator("button").getAttribute("onclick")).toBeNull();
    expect(await frame.locator("form, img, image, iframe, object").count()).toBe(0);
    expect(
      await frame.locator("body > div").evaluate((element: HTMLDivElement) => element.inert),
    ).toBe(true);
    expect(
      await frame.evaluate(
        () => Object.hasOwn(globalThis, "widgetRan") || Object.hasOwn(globalThis, "openclaw"),
      ),
    ).toBe(false);
    expect(
      await frame.evaluate(() => {
        try {
          void window.parent.document;
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    await expect.poll(() => failures.size).toBe(requests.length);
    expect([...failures.values()]).toEqual(["csp", "csp"]);
    expect(assetRequests).toBe(1);
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
});
