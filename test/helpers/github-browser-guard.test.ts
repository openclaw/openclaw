import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expect, it } from "vitest";
import {
  installGitHubChromiumGuard,
  withGitHubBrowserNegativeControls,
} from "./github-browser-guard.mjs";
import { githubNetworkAttemptCounts, withGitHubNegativeControl } from "./github-network-guard.mjs";

it.each(["--proxy-server=http://127.0.0.1:9", "--host-resolver-rules=EXCLUDE *.com"])(
  "refuses Chromium overrides that defeat redirect blocking: %s",
  async (arg) => {
    const { chromium } = await import("playwright");
    installGitHubChromiumGuard(chromium);
    await expect(
      withGitHubNegativeControl(async () => {
        const browser = await chromium.launch({ headless: true, args: [arg] });
        await browser.close();
      }),
    ).rejects.toThrow("GitHub network access is forbidden in ordinary tests");
  },
);

it("blocks Chromium HTTP and WebSocket requests before they reach a non-forwarding proxy", async () => {
  const { chromium } = await import("playwright");
  installGitHubChromiumGuard(chromium);
  let githubRequests = 0;
  let fixtureRequests = 0;
  const sockets = new Set<Socket>();
  const proxy = createServer((req, res) => {
    if (req.url?.includes("github.com")) {
      githubRequests++;
    }
    if (req.url?.includes("fixture.example.test")) {
      fixtureRequests++;
    }
    if (req.url?.endsWith("/redirect")) {
      res.writeHead(302, {
        location: "https://github.com/redirect-negative-control",
        "access-control-allow-origin": "*",
      });
      res.end();
      return;
    }
    res.writeHead(200, { "access-control-allow-origin": "*" });
    res.end("synthetic response");
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (req, socket) => {
    if (req.url?.includes("github.com")) {
      githubRequests++;
    }
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  proxy.on("upgrade", (req, socket) => {
    if (req.url?.includes("github.com")) {
      githubRequests++;
    }
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("proxy did not bind TCP");
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ proxy: { server: `http://127.0.0.1:${address.port}` } });
    expect(
      await page.evaluate(() =>
        fetch("http://fixture.example.test/").then((response) => response.text()),
      ),
    ).toBe("synthetic response");
    expect(fixtureRequests).toBe(1);
    await page.route("https://github.com/fulfilled-fixture", (route) =>
      route.fulfill({
        body: "mocked",
        headers: { "access-control-allow-origin": "*" },
      }),
    );
    const clean = githubNetworkAttemptCounts();
    expect(
      await page.evaluate(() =>
        fetch("https://github.com/fulfilled-fixture").then((r) => r.text()),
      ),
    ).toBe("mocked");
    expect(githubNetworkAttemptCounts()).toEqual(clean);
    const before = githubNetworkAttemptCounts().negativeControl;
    const result = await withGitHubBrowserNegativeControls(
      page.context(),
      [
        "https://github.com/openclaw-guard-negative-control",
        "wss://github.com/openclaw-guard-negative-control",
        "https://github.com/redirect-negative-control",
      ],
      () =>
        page.evaluate(async () => {
          const http = await fetch("https://github.com/openclaw-guard-negative-control").then(
            () => "opened",
            () => "blocked",
          );
          const websocket = await new Promise<string>((resolve) => {
            const socket = new WebSocket("wss://github.com/openclaw-guard-negative-control");
            socket.addEventListener("open", () => {
              socket.close();
              resolve("opened");
            });
            socket.addEventListener("error", () => resolve("blocked"));
            socket.addEventListener("close", () => resolve("blocked"));
          });
          const redirect = await fetch("http://fixture.example.test/redirect").then(
            () => "opened",
            () => "blocked",
          );
          return { http, websocket, redirect };
        }),
    );
    expect(result).toEqual({ http: "blocked", websocket: "blocked", redirect: "blocked" });
    expect(githubNetworkAttemptCounts().negativeControl).toBe(before + 3);
    expect(githubRequests).toBe(0);
  } finally {
    await browser?.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
