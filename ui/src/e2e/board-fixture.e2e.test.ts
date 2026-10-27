import { writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl, type ControlUiMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import {
  startFixtureServer,
  stopFixtureServer,
  type FixtureServer,
} from "./board-fixture-server.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const {
  executablePath: chromiumExecutablePath,
  available: chromiumAvailable,
  wsEndpoint: chromiumWsEndpoint,
} = inject("controlUiE2eChromium");
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const describeStandaloneMockServer =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

function colorChannelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function colorLuminance(color: RenderedColor): number {
  if (color.alpha !== 1) {
    throw new Error(`transparent computed color requires compositing: ${JSON.stringify(color)}`);
  }
  return (
    0.2126 * colorChannelToLinear(color.red) +
    0.7152 * colorChannelToLinear(color.green) +
    0.0722 * colorChannelToLinear(color.blue)
  );
}

function colorContrast(foreground: RenderedColor, background: RenderedColor): number {
  const lighter = Math.max(colorLuminance(foreground), colorLuminance(background));
  const darker = Math.min(colorLuminance(foreground), colorLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function openWidgetMenu(page: Page): Promise<void> {
  const widget = page.locator('[data-test-id="board-widget"]').first();
  await widget.focus();
  await widget.locator(".board-widget__menu-trigger").click();
  await widget.locator(".board-widget__menu-panel:popover-open").waitFor();
}

async function readMenuColors(page: Page): Promise<{ background: string; foreground: string }> {
  return page.evaluate(() => {
    const menu = document.querySelector(".board-widget__menu-panel:popover-open");
    const item = menu?.querySelector('[role="menuitem"]:not(.board-widget__menu-danger)');
    if (!(item instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
      throw new Error("board fixture menu did not expose its surface and first item");
    }
    return {
      background: getComputedStyle(menu).backgroundColor,
      foreground: getComputedStyle(item).color,
    };
  });
}

let browser: Browser;
let fixtureServer: FixtureServer;

function connectFixtureBrowser() {
  return chromiumWsEndpoint
    ? chromium.connect(chromiumWsEndpoint, { timeout: 30_000 })
    : chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
}

function withFixturePage(run: (page: Page) => Promise<void>) {
  return async () => {
    const page = await browser.newPage();
    try {
      await run(page);
    } finally {
      await page.close();
    }
  };
}

async function openPreviewChat(page: Page) {
  await page.goto(new URL("/chat", fixtureServer.url).toString());
  await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
}

async function isolatedPage(
  url = fixtureServer.url,
  options: Parameters<Browser["newContext"]>[0] = {},
  allowedOrigins: string[] = [],
  abortCode = "blockedbyclient",
) {
  const context = await browser.newContext(options);
  const origin = new URL(url).origin;
  const escaped: string[] = [],
    requests: string[] = [];
  try {
    await context.route("**/*", (route) => {
      const target = route.request().url();
      requests.push(target);
      if ([origin, ...allowedOrigins].includes(new URL(target).origin)) {
        return route.continue();
      }
      escaped.push(target);
      return route.abort(abortCode);
    });
    return { context, page: await context.newPage(), origin, escaped, requests };
  } catch (error) {
    await context.close();
    throw error;
  }
}

const textMessage = (role: string, text: string) =>
  expect.objectContaining({
    role,
    content: [{ type: "text", text: expect.stringContaining(text) }],
  });

async function requestPreviewGateway(
  page: Page,
  requests: Array<{ method: string; params?: unknown }>,
): Promise<unknown[]> {
  return evaluateControlUiContext(
    page,
    (context, batch) => {
      const client = context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Preview Gateway client is unavailable");
      }
      return Promise.all(batch.map(({ method, params }) => client.request(method, params)));
    },
    requests,
  );
}

async function probeNativeEgress(page: Page, sinkUrl: string) {
  return page.evaluate(async (sinkOrigin) => {
    const results: Record<string, string> = {};
    const rejected = async (name: string, run: () => unknown) => {
      try {
        await run();
        results[name] = "allowed";
      } catch {
        results[name] = "blocked";
      }
    };
    const localForm = document.createElement("form");
    localForm.addEventListener("submit", (event) => {
      event.preventDefault();
      results.formHandler = "handled";
    });
    document.body.append(localForm);
    localForm.requestSubmit();
    localForm.remove();
    await rejected("fetch", () => fetch(`${sinkOrigin}/fetch`));
    await rejected("rtc", () => new RTCPeerConnection());
    const workerUrl = URL.createObjectURL(
      new Blob(["postMessage('escaped')"], { type: "text/javascript" }),
    );
    const worker = new Worker(workerUrl);
    await rejected(
      "worker",
      () =>
        new Promise((resolve, reject) => {
          worker.addEventListener("message", resolve, { once: true });
          worker.addEventListener("error", reject, { once: true });
        }),
    );
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    results.popup = window.open(`${sinkOrigin}/popup`) === null ? "blocked" : "allowed";

    // Each native attempt completes at the browser's policy event; no sleep
    // or request interception can make a missing boundary pass this proof.
    const policy = async (name: string, directive: string, run: () => void) => {
      await new Promise<void>((resolve) => {
        const listener = (event: SecurityPolicyViolationEvent) => {
          if (event.effectiveDirective !== directive || !event.blockedURI.startsWith(sinkOrigin)) {
            return;
          }
          document.removeEventListener("securitypolicyviolation", listener);
          resolve();
        };
        document.addEventListener("securitypolicyviolation", listener);
        run();
      });
      results[name] = "blocked";
    };
    // The navigation guard cancels this POST before CSP evaluates it.
    const form = document.createElement("form");
    form.action = `${sinkOrigin}/form`;
    form.method = "POST";
    document.body.append(form);
    await new Promise<void>((resolve) => {
      window.navigation.addEventListener(
        "navigate",
        (event) => {
          results.form =
            event.destination.url === form.action && event.defaultPrevented ? "blocked" : "allowed";
          resolve();
        },
        { once: true },
      );
      form.submit();
    });
    form.remove();
    await policy("xhr", "connect-src", () => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", `${sinkOrigin}/xhr`);
      xhr.send();
    });
    let events: EventSource;
    await policy("eventSource", "connect-src", () => {
      events = new EventSource(`${sinkOrigin}/events`);
    });
    events!.close();
    await policy("beacon", "connect-src", () => {
      navigator.sendBeacon(`${sinkOrigin}/beacon`, "probe");
    });
    await policy("image", "img-src", () => {
      const image = new Image();
      image.src = `${sinkOrigin}/image`;
      document.body.append(image);
    });
    await policy("media", "media-src", () => {
      const audio = document.createElement("audio");
      audio.preload = "auto";
      audio.src = `${sinkOrigin}/media`;
      document.body.append(audio);
      audio.load();
    });
    for (const setter of ["property", "attribute", "namespaced", "empty-namespace"] as const) {
      await rejected(`iframe:${setter}`, () => {
        const frame = document.createElement("iframe");
        const url = `${sinkOrigin}/frame`;
        if (setter === "property") {
          frame.src = url;
        } else if (setter === "attribute") {
          frame.setAttribute("src", url);
        } else {
          const namespace = setter === "namespaced" ? null : "";
          frame.setAttributeNS(namespace, "src", url);
        }
        document.body.append(frame);
      });
    }
    await policy("script", "script-src-elem", () => {
      const script = document.createElement("script");
      script.src = `${sinkOrigin}/script`;
      document.head.append(script);
    });
    await policy("style", "style-src-elem", () => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${sinkOrigin}/style`;
      document.head.append(link);
    });
    await rejected("font", () => new FontFace("sink-probe", `url(${sinkOrigin}/font)`).load());
    const forgedHmr = new WebSocket(`${sinkOrigin.replace("http:", "ws:")}/forged-hmr`, "vite-hmr");
    await new Promise<void>((resolve) => {
      forgedHmr.addEventListener("error", () => resolve(), { once: true });
    });
    forgedHmr.close();
    results.forgedHmr = "blocked";
    const beforeNavigation = location.href;
    location.assign(`${sinkOrigin}/navigation`);
    results.navigation = location.href === beforeNavigation ? "blocked" : "allowed";
    // Same-origin completion sentinel proves the document is still live.
    const sentinel = await fetch("/control-ui-config.json");
    results.sentinel = sentinel.ok ? "local" : "failed";
    return results;
  }, sinkUrl);
}

describeStandaloneMockServer("standalone Control UI mock server", () => {
  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    browser = await connectFixtureBrowser();
  });

  afterAll(async () => {
    await runQaGatewayFixture(
      async () => {
        await browser?.close();
      },
      () => stopFixtureServer(fixtureServer),
    );
  });

  describe("Gateway fixture contracts", () => {
    // These Gateway contracts share one mounted preview; other UI flows keep fresh pages.
    let page: Page;

    beforeAll(async () => {
      page = await browser.newPage();
      await openPreviewChat(page);
    });

    afterAll(async () => {
      await page?.close();
    });

    it("correlates concurrent caretaker replies with their original requests", async () => {
      const replies = await requestPreviewGateway(page, [
        { method: "openclaw.chat", params: { sessionId: "delayed", message: "hello" } },
        { method: "openclaw.chat", params: { sessionId: "welcome" } },
      ]);
      expect(replies).toMatchObject([
        { sessionId: "delayed", reply: expect.stringContaining("demo turn 0") },
        { sessionId: "welcome", reply: expect.stringContaining("system caretaker") },
      ]);
    });

    it("keeps generated search-session metadata in the canonical fixture catalog", async () => {
      const replies = await requestPreviewGateway(
        page,
        ["telegram", "claude"].map((search) => ({
          method: "sessions.list",
          params: { search },
        })),
      );
      expect(replies).toMatchObject([
        {
          sessions: expect.arrayContaining([
            expect.objectContaining({ label: "Telegram investigation 001", model: "gpt-5-mini" }),
          ]),
        },
        {
          sessions: expect.arrayContaining([
            expect.objectContaining({
              label: "Model search result 001",
              model: "claude-sonnet-4-6",
            }),
          ]),
        },
      ]);
    });

    it("keeps the main preview run active when hydrating canonical session metadata", async () => {
      expect(
        await requestPreviewGateway(page, [
          { method: "chat.startup", params: { sessionKey: "agent:main:main" } },
        ]),
      ).toMatchObject([
        {
          sessionInfo: { hasActiveRun: true, status: "running", activeRunIds: ["mock-plan-run"] },
          inFlightRun: { runId: "mock-plan-run" },
        },
      ]);
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
    });

    it("serves preview session agent:main:tax-research through both chat entry points", async () => {
      const sessionKey = "agent:main:tax-research";
      const sampledAt = 1_790_598_431_356;
      await page.clock.setFixedTime(sampledAt);
      const [description] = (await requestPreviewGateway(page, [
        { method: "sessions.describe", params: { key: sessionKey } },
      ])) as Array<{ session: { sessionId: string; snapshotAt: number } }>;
      expect(description).toMatchObject({
        session: { key: sessionKey, sessionId: expect.any(String), snapshotAt: sampledAt },
      });
      // Each projection samples its read clock, not the stored row. Advance
      // Date without delaying timers so descriptor/history/startup cannot
      // accidentally pass by sharing one millisecond.
      const replies: unknown[] = [];
      for (const [index, method] of ["chat.history", "chat.startup"].entries()) {
        await page.clock.setFixedTime(sampledAt + index + 1);
        const [reply] = await requestPreviewGateway(page, [{ method, params: { sessionKey } }]);
        replies.push(reply);
      }
      const userMessage = textMessage("user", "Inspect this session.");
      const assistantMessage = textMessage(
        "assistant",
        "The current state is available in the session controls.",
      );
      for (const [index, reply] of replies.entries()) {
        expect(reply).toMatchObject({
          sessionId: description!.session.sessionId,
          sessionInfo: { ...description!.session, snapshotAt: sampledAt + index + 1 },
          messages: expect.arrayContaining([userMessage, assistantMessage]),
        });
        const messages = asNullableRecord(reply)?.messages;
        if (!Array.isArray(messages)) {
          throw new Error("Background task history must contain messages");
        }
        const userIndex = messages.findIndex((message) => userMessage.asymmetricMatch(message));
        const assistantIndex = messages.findIndex((message) =>
          assistantMessage.asymmetricMatch(message),
        );
        expect(userIndex).toBeLessThan(assistantIndex);
      }
      const history = asNullableRecord(replies[0]);
      expect(replies[1]).toMatchObject({
        ...history,
        sessionInfo: {
          ...asNullableRecord(history?.sessionInfo),
          snapshotAt: sampledAt + 2,
        },
      });
    });

    // Keep the mutating group contract last on this shared page.
    it("keeps renamed preview groups authoritative across reads and reloads", async () => {
      await requestPreviewGateway(page, [
        { method: "sessions.groups.rename", params: { name: "Research", to: "Reviewed" } },
      ]);
      for (const reload of [false, true]) {
        if (reload) {
          await page.reload();
          await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        }
        expect(await requestPreviewGateway(page, [{ method: "sessions.groups.list" }])).toEqual([
          { groups: [{ name: "Reviewed", position: 0 }], sectionOrder: [] },
        ]);
      }
    });
  });

  it("keeps synthetic avatar requests on the preview origin across reloads", async () => {
    const {
      context,
      page,
      origin: previewOrigin,
      escaped,
    } = await isolatedPage(fixtureServer.url, {}, [], "failed");
    const avatarRequests: string[] = [];
    try {
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/users/presence-riley/avatar") {
          avatarRequests.push(request.url());
        }
      });
      await page.goto(`${previewOrigin}/chat/main?skillLibrary=collaborator`);
      for (const reload of [false, true]) {
        if (reload) {
          avatarRequests.length = 0;
          await page.reload();
        }
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        await expect.poll(() => avatarRequests.length).toBeGreaterThan(0);
        expect([...new Set(avatarRequests.map((url) => new URL(url).origin))]).toEqual([
          previewOrigin,
        ]);
        expect(escaped).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });

  it("keeps profile and presence HTTP inside the standalone mock", async () => {
    const artifacts = createControlUiE2eArtifactDir("standalone-network-isolation");
    const { context, page, origin, escaped, requests } = await isolatedPage(fixtureServer.url, {
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
      recordVideo: captureUiProof ? { dir: artifacts } : undefined,
    });
    await runQaGatewayFixture(
      async () => {
        await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
        // The fixture viewer is Riley; this shared checkout belongs to Peter.
        await selectAllSidebarSessions(page);
        await page.getByText("OpenClaw work checkout", { exact: true }).click();
        await page.getByRole("button", { name: "Write a message to send." }).waitFor();
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifacts, "chat.png") });
        }
        await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded" });
        await expect
          .poll(() => page.getByRole("textbox", { name: "Display name", exact: true }).inputValue())
          .toBe("Riley");
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifacts, "profile.png") });
        }
        await page.goto(`${origin}/focus/terminal`, { waitUntil: "domcontentloaded" });
        const terminal = page.locator("openclaw-terminal-panel");
        await terminal.locator(".tabstrip-tab.is-live").waitFor();
        await terminal.locator(".tp-host canvas").waitFor({ state: "visible" });
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifacts, "terminal.png") });
        }
        expect(
          escaped,
          "standalone mock must not attempt Gateway HTTP or external requests",
        ).toEqual([]);
      },
      () =>
        writeFile(
          path.join(artifacts, "network.json"),
          JSON.stringify({ origin, escaped, requests }, null, 2),
        ),
      () => context.close(),
    );
  });

  it("blocks native egress before connecting while preserving local HMR and frame resources", async () => {
    const artifacts = createControlUiE2eArtifactDir("standalone-network-probes");
    const received: string[] = [];
    let connections = 0;
    const sink = createHttpServer((req, res) => {
      received.push(req.url ?? "/");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end("unexpected egress");
    });
    sink.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => {
      sink.listen(0, "127.0.0.1", resolve);
    });
    const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    const origin = new URL(fixtureServer.url).origin;
    let context: BrowserContext | undefined;
    let escaped: string[] = [];
    const outcomes: Record<string, unknown> = {};
    await runQaGatewayFixture(
      async () => {
        // Allow the synthetic sink through: the browser/server boundary, not the
        // test router, must prevent TCP connections. Still protect other origins.
        const isolated = await isolatedPage(fixtureServer.url, { serviceWorkers: "block" }, [
          sinkUrl,
        ]);
        context = isolated.context;
        escaped = isolated.escaped;
        const { page } = isolated;
        const hmr: string[] = [];
        page.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            if (String(payload).includes('"type":"connected"')) {
              hmr.push(new URL(socket.url()).origin);
            }
          });
        });
        await page.goto(fixtureServer.url, { waitUntil: "domcontentloaded" });
        await page.locator('[data-test-id="board-widget"]').first().waitFor();
        const localWorkerOutput = await page.evaluate(async () => {
          const canvas = new OffscreenCanvas(1, 1);
          canvas.getContext("2d")?.fillRect(0, 0, 1, 1);
          const image = new File([await canvas.convertToBlob({ type: "image/png" })], "dot.png", {
            type: "image/png",
          });
          const worker = new Worker(
            "/src/pages/chat/components/chat-attachment-image.worker.ts?worker_file&type=module",
            { type: "module" },
          );
          try {
            return await new Promise<string | null>((resolve, reject) => {
              worker.addEventListener("message", ({ data }: MessageEvent<File | null>) =>
                resolve(data?.type ?? null),
              );
              worker.addEventListener("error", () =>
                reject(new Error("The local image worker could not run.")),
              );
              worker.postMessage({ file: image, maxBytes: 1024 * 1024 }, []);
            });
          } finally {
            worker.terminate();
          }
        });
        expect(localWorkerOutput).toBe("image/png");
        await expect.poll(() => hmr.length).toBeGreaterThan(0);
        expect(hmr.every((url) => new URL(url).host === new URL(origin).host)).toBe(true);
        outcomes.hmr = hmr;

        outcomes.top = await probeNativeEgress(page, sinkUrl);
        const blocked = `form fetch rtc worker popup xhr eventSource beacon image media
          iframe:property iframe:attribute iframe:namespaced iframe:empty-namespace
          script style font forgedHmr navigation`.split(/\s+/u);
        expect(outcomes.top).toEqual({
          ...Object.fromEntries(blocked.map((name) => [name, "blocked"])),
          formHandler: "handled",
          sentinel: "local",
        });
        expect(new URL(page.url()).origin).toBe(origin);

        await expect
          .poll(() => page.frames().some((frame) => frame.url().startsWith("data:text/html")))
          .toBe(true);
        const widgetFrame = page
          .frames()
          .find((frame) => frame.url().startsWith("data:text/html"))!;
        outcomes.frame = await widgetFrame.evaluate(async (sinkOrigin) => {
          try {
            await fetch(`${sinkOrigin}/frame-native-fetch`);
            return "allowed";
          } catch {
            return "blocked";
          }
        }, sinkUrl);
        expect(outcomes.frame).toBe("blocked");
        const missing = await page.evaluate(async () => {
          const apiResponse = await fetch("/api/unimplemented-mock-probe");
          return { status: apiResponse.status, body: await apiResponse.json() };
        });
        expect(missing).toEqual({
          status: 404,
          body: { error: "Standalone mock has no HTTP fixture for this route." },
        });
        outcomes.missing = missing;
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifacts, "board.png") });
        }
        expect(escaped).toEqual([]);
        expect(received).toEqual([]);
        expect(connections).toBe(0);
      },
      () => context?.close(),
      async () => {
        sink.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          sink.close((error) => (error ? reject(error) : resolve()));
        });
      },
      () =>
        writeFile(
          path.join(artifacts, "probes.json"),
          JSON.stringify(
            { origin, sinkOrigin: sinkUrl, connections, received, escaped, outcomes },
            null,
            2,
          ),
        ),
    );
  });

  it("serves attachment fixtures and blob previews under the same isolation policy", async () => {
    const attachments = await startFixtureServer("attachments");
    let context: BrowserContext | undefined;
    await runQaGatewayFixture(
      async () => {
        const artifacts = createControlUiE2eArtifactDir("standalone-isolated-attachments");
        const isolated = await isolatedPage(attachments.url, { serviceWorkers: "block" });
        context = isolated.context;
        const { page, origin, escaped } = isolated;
        await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        const result = await page.evaluate(async () => {
          const response = await fetch("/__fixtures/chat-attachments/sample-image.svg");
          const blob = await response.blob();
          const image = new Image();
          image.src = URL.createObjectURL(blob);
          document.body.append(image);
          await image.decode();
          URL.revokeObjectURL(image.src);
          return {
            type: blob.type,
            width: image.naturalWidth,
            policy: response.headers.get("content-security-policy"),
          };
        });
        expect(result).toMatchObject({
          type: "image/svg+xml",
          width: 640,
          policy: expect.stringContaining("worker-src 'self'"),
        });
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifacts, "attachments.png") });
        }
        expect(escaped).toEqual([]);
        await writeFile(
          path.join(artifacts, "network.json"),
          JSON.stringify({ origin, escaped, result }, null, 2),
        );
      },
      () => context?.close(),
      () => stopFixtureServer(attachments),
    );
  });

  it.each(["dark", "light"] as const)(
    "themes dropdown items and widget frames in %s mode",
    async (mode) => {
      const context = await browser.newContext({ colorScheme: mode });
      try {
        const page = await context.newPage();
        await page.goto(fixtureServer.url, { waitUntil: "domcontentloaded" });
        await expect
          .poll(() =>
            page.locator("html").evaluate((root) => ({
              theme: (root as HTMLElement).dataset.theme,
              themeMode: (root as HTMLElement).dataset.themeMode,
            })),
          )
          .toEqual({ theme: mode, themeMode: mode });

        await openWidgetMenu(page);
        if (mode === "light") {
          const presentation = await page
            .locator(".board-widget__menu-panel:popover-open .board-widget__menu-danger")
            .evaluate((action) => {
              const menu = action.parentElement;
              const move = menu?.querySelector('[role="menuitem"][data-value^="move:"]');
              const preset = menu?.querySelector(".board-widget__preset");
              const icon = action.querySelector(".board-widget__menu-icon");
              if (!(move instanceof HTMLElement) || !(preset instanceof HTMLElement)) {
                throw new Error("board fixture menu did not expose move and resize options");
              }
              return {
                actionFontSize: getComputedStyle(action).fontSize,
                actionText: action.textContent?.trim(),
                iconHidden: icon?.getAttribute("aria-hidden"),
                iconSvg: Boolean(icon?.querySelector("svg")),
                moveFontSize: getComputedStyle(move).fontSize,
                presetFontSize: getComputedStyle(preset).fontSize,
              };
            });
          expect(presentation).toMatchObject({
            actionText: "Delete",
            actionFontSize: presentation.presetFontSize,
            moveFontSize: presentation.presetFontSize,
            iconHidden: "true",
            iconSvg: true,
          });
        }
        const colors = await page.evaluate(resolveRenderedColors, await readMenuColors(page));
        expect(colorContrast(colors.foreground!, colors.background!)).toBeGreaterThanOrEqual(4.5);

        const widgetBackgrounds = await page
          .locator('[data-test-id="board-widget"]')
          .first()
          .evaluate((widget) => {
            const frame = widget.querySelector(".board-widget__frame");
            if (!(frame instanceof HTMLIFrameElement)) {
              throw new Error("board widget frame is missing");
            }
            return {
              frame: getComputedStyle(frame).backgroundColor,
              widget: getComputedStyle(widget).backgroundColor,
            };
          });
        expect(widgetBackgrounds.frame).toBe(widgetBackgrounds.widget);
        expect(widgetBackgrounds.frame).not.toBe("rgba(0, 0, 0, 0)");

        await expect
          .poll(() => page.frames().some((frame) => frame.url().startsWith("data:text/html")))
          .toBe(true);
        const widgetFrame = page.frames().find((frame) => frame.url().startsWith("data:text/html"));
        expect(widgetFrame).toBeDefined();
        await expect
          .poll(() =>
            widgetFrame!.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
          )
          .toBe(mode);
        if (mode === "dark") {
          await page.emulateMedia({ colorScheme: "light" });
          await expect
            .poll(() => page.locator("html").getAttribute("data-theme-mode"))
            .toBe("light");
        }
      } finally {
        await context.close();
      }
    },
  );

  it(
    "opens a visible catalog session with its transcript in chronological order",
    withFixturePage(async (page) => {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), {
        waitUntil: "domcontentloaded",
      });
      // External catalog sessions have no human owner.
      await selectAllSidebarSessions(page);
      await page.getByText("Release checklist sweep", { exact: true }).click();

      const transcript = [
        "Please sweep the release checklist for anything we missed.",
        "The release checklist is complete and ready for review.",
      ];
      await Promise.all(transcript.map((text) => page.getByText(text, { exact: true }).waitFor()));

      await expect
        .poll(() =>
          page
            .locator(".chat-pane-cache__pane--active .chat-thread .chat-bubble")
            .evaluateAll((bubbles) =>
              bubbles.map((bubble) => bubble.querySelector(".chat-text")?.textContent?.trim()),
            ),
        )
        .toEqual(transcript);
      expect(
        await page
          .getByText("Cannot read properties of undefined (reading 'toReversed')", { exact: false })
          .count(),
      ).toBe(0);
    }),
  );

  it(
    "starts with aligned build identity and renders a deterministic reply after generic chat.send",
    withFixturePage(async (page) => {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), {
        waitUntil: "domcontentloaded",
      });
      await selectAllSidebarSessions(page);
      await page.getByText("OpenClaw work checkout", { exact: true }).click();

      await page.getByRole("button", { name: "Write a message to send." }).waitFor();
      expect(await page.locator(".community-invite-card").count()).toBe(0);
      expect(await page.getByText("Server updated", { exact: true }).count()).toBe(0);
      const paneState = await page
        .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
        .evaluate(async (pane) => {
          const chatPane = pane as HTMLElement & {
            transcriptReady: boolean;
            updateComplete: Promise<unknown>;
          };
          await chatPane.updateComplete;
          const constructor = customElements.get("openclaw-chat-pane");
          return {
            connected: chatPane.isConnected,
            transcriptReady: chatPane.transcriptReady,
            registered: constructor !== undefined,
            upgraded: constructor !== undefined && chatPane instanceof constructor,
          };
        });
      expect(paneState).toEqual({
        connected: true,
        transcriptReady: true,
        registered: true,
        upgraded: true,
      });
      expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(0);

      const prompt = "generic mock send probe";
      const composer = page.locator(
        ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
      );
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await page
        .locator(".chat-thread-inner")
        .getByText(`Mock reply: ${prompt}`, { exact: true })
        .waitFor();
      expect(await composer.inputValue()).toBe("");
    }),
  );
});

describeStandaloneMockServer("standalone native plugin preview", () => {
  let server: FixtureServer;
  let previewBrowser: Browser;

  beforeAll(async () => {
    server = await startFixtureServer("workboard");
    previewBrowser = await connectFixtureBrowser();
  });

  afterAll(async () => {
    await previewBrowser?.close();
    await stopFixtureServer(server);
  });

  it("loads native plugin pages and dashboard widgets in the standalone preview", async () => {
    const artifactDir = createControlUiE2eArtifactDir("standalone-native-plugin-preview");
    const context = await previewBrowser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: captureUiProof
        ? { dir: artifactDir, size: { width: 1440, height: 1000 } }
        : undefined,
    });
    const page = await context.newPage();
    let completed = false;
    try {
      await page.goto(new URL("/workboard", server.url).toString());
      await page.getByText("Capture customer feedback themes", { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const gateway = (
              window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
            ).openclawControlUiE2eGateway;
            return gateway?.requests
              .filter((request) => request.method === "plugins.controlUi.report")
              .map((request) => request.params);
          }),
        )
        .toEqual(
          expect.arrayContaining([
            {
              reports: expect.arrayContaining([
                expect.objectContaining({ pluginId: "workboard", status: "activated" }),
              ]),
            },
          ]),
        );
      if (captureUiProof) {
        await page.screenshot({ path: path.join(artifactDir, "native-page.png"), fullPage: true });
      }

      await page.goto(
        controlUiSessionUrl(
          new URL("/", server.url).toString(),
          "agent:main:workboard-proof",
          "dashboard",
        ),
      );
      const widget = page.locator('[data-test-id="workboard-board-widget"]');
      await widget.getByText("Capture customer feedback themes", { exact: true }).waitFor();
      expect(await page.getByText("Unknown plugin widget", { exact: false }).count()).toBe(0);
      if (captureUiProof) {
        await page.screenshot({
          path: path.join(artifactDir, "native-widget.png"),
          fullPage: true,
        });
      }
      completed = true;
    } finally {
      if (captureUiProof || !completed) {
        await page.screenshot({ path: path.join(artifactDir, "final.png"), fullPage: true });
      }
      await context.close();
    }
  });
});
