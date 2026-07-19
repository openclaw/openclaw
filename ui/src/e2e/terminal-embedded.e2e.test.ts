import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const deadSessionScreenshotPath = process.env.OPENCLAW_TERMINAL_DEAD_SESSION_SCREENSHOT?.trim();
const deadSessionVideoDir = process.env.OPENCLAW_TERMINAL_DEAD_SESSION_VIDEO_DIR?.trim();
const utf8ProofArtifactDir =
  process.env.OPENCLAW_TERMINAL_UTF8_PROOF_DIR?.trim() ||
  path.resolve(".artifacts/control-ui-e2e/terminal-startup-utf8");

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("embedded terminal document", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders only the terminal with a tab-attached close control while native auth connects", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: {
            gatewayUrl: string;
            token: string;
          };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: "ws://gateway.example.test",
        token: "native-terminal-token",
      };
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      featureMethods: ["terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "terminal-e2e",
          shell: "/bin/bash",
        },
      },
      terminalEnabled: true,
    });

    try {
      const response = await page.goto(`${server.baseUrl}?view=terminal`);
      expect(response?.status()).toBe(200);
      const connect = await gateway.waitForRequest("connect");

      expect(connect.params).toMatchObject({ auth: { token: "native-terminal-token" } });
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);

      await gateway.resolveDeferred("connect");
      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({
        cols: expect.any(Number),
        rows: expect.any(Number),
      });
      const colorQueries = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\";
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "terminal-e2e",
        seq: colorQueries.length,
        data: colorQueries,
      });
      await expect.poll(async () => (await gateway.getRequests("terminal.input")).length).toBe(2);
      expect((await gateway.getRequests("terminal.input")).map(({ params }) => params)).toEqual([
        {
          sessionId: "terminal-e2e",
          data: "\u001b]10;rgb:1b1b/1e1e/2626\u001b\\",
        },
        {
          sessionId: "terminal-e2e",
          data: "\u001b]11;rgb:f7f7/f8f8/fafa\u001b\\",
        },
      ]);
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);
      const closeControlMetrics = await page
        .locator("openclaw-terminal-panel")
        .locator(".tabstrip-tab__close")
        .evaluate((close) => {
          const header = close.closest<HTMLElement>(".tp-header");
          if (!header) {
            throw new Error("Terminal close control must stay inside the tab header");
          }
          const headerBounds = header.getBoundingClientRect();
          const closeBounds = close.getBoundingClientRect();
          return {
            centerOffset: Math.abs(
              closeBounds.top +
                closeBounds.height / 2 -
                (headerBounds.top + headerBounds.height / 2),
            ),
            height: closeBounds.height,
            width: closeBounds.width,
          };
        });
      expect(closeControlMetrics.width).toBe(24);
      expect(closeControlMetrics.height).toBe(36);
      expect(closeControlMetrics.centerOffset).toBeLessThanOrEqual(0.5);
      const closeControl = page.locator("openclaw-terminal-panel").locator(".tabstrip-tab__close");
      expect(await closeControl.getAttribute("aria-label")).toBe("Close terminal session: bash");
      await closeControl.click();
      const terminalClose = await gateway.waitForRequest("terminal.close");
      expect(terminalClose.params).toEqual({ sessionId: "terminal-e2e" });
    } finally {
      await context.close();
    }
  });

  it("keeps split CJK/emoji UTF-8 intact across deferred terminal.open adoption", async () => {
    await fs.mkdir(utf8ProofArtifactDir, { recursive: true });
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: utf8ProofArtifactDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.text().includes("[terminal-utf8-proof]")) {
        console.info(msg.text());
      }
    });
    await page.addInitScript(() => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: {
            gatewayUrl: string;
            token: string;
          };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: "ws://gateway.example.test",
        token: "native-terminal-utf8-token",
      };
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect", "terminal.open"],
      featureMethods: ["terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
      },
      terminalEnabled: true,
    });

    try {
      const response = await page.goto(`${server.baseUrl}?view=terminal`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("terminal.open");
      await page.locator("openclaw-terminal-panel .tabstrip-tab.is-connecting").waitFor();
      await page.screenshot({
        path: path.join(utf8ProofArtifactDir, "connecting-before-adopt.png"),
        fullPage: true,
      });

      // Chromium exercises the production helper (same TextDecoder stream contract
      // the panel wires to Ghostty onData) while terminal.open is still deferred.
      const moduleUrl = new URL("src/components/terminal/terminal-startup-input.ts", server.baseUrl)
        .href;
      await page.addScriptTag({
        content: `globalThis.openclawTerminalStartupInputModule = import(${JSON.stringify(moduleUrl)});`,
        type: "module",
      });
      const browserDecode = await page.evaluate(async () => {
        const mod = await (
          window as unknown as Window & {
            openclawTerminalStartupInputModule: Promise<{
              createTerminalStartupInput: (
                connection: {
                  input: (sessionId: string, data: string) => void;
                  resize: () => void;
                },
                getSessionId: () => string | undefined,
              ) => {
                onData: (bytes: Uint8Array) => void;
                buffer: { drain: () => string[] };
              };
            }>;
          }
        ).openclawTerminalStartupInputModule;
        const delivered: string[] = [];
        let sessionId: string | undefined;
        const startup = mod.createTerminalStartupInput(
          {
            input: (_id, data) => {
              delivered.push(data);
            },
            resize: () => {},
          },
          () => sessionId,
        );
        startup.onData(Uint8Array.of(0xe4, 0xb8));
        const pendingBeforeAdopt = startup.buffer.drain();
        sessionId = "terminal-utf8-e2e";
        for (const data of startup.buffer.drain()) {
          delivered.push(data);
        }
        startup.onData(Uint8Array.of(0xad));
        for (const byte of new TextEncoder().encode("😀")) {
          startup.onData(Uint8Array.of(byte));
        }
        const joined = delivered.join("");
        console.info(
          `[terminal-utf8-proof] browser helper across adopt: pendingBefore=${JSON.stringify(pendingBeforeAdopt)} delivered=${JSON.stringify(delivered)} joined=${JSON.stringify(joined)} hasFFFD=${joined.includes("\uFFFD")}`,
        );
        return { pendingBeforeAdopt, delivered, joined, hasFFFD: joined.includes("\uFFFD") };
      });
      expect(browserDecode.pendingBeforeAdopt).toEqual([]);
      expect(browserDecode.joined).toBe("中😀");
      expect(browserDecode.hasFFFD).toBe(false);

      await gateway.resolveDeferred("terminal.open", {
        agentId: "main",
        confined: false,
        cwd: "/workspace",
        sessionId: "terminal-utf8-e2e",
        shell: "/bin/bash",
      });
      await expect
        .poll(async () =>
          page.locator("openclaw-terminal-panel .tabstrip-tab.is-connecting").count(),
        )
        .toBe(0);
      expect(await page.locator("openclaw-terminal-panel .tabstrip-tab").count()).toBe(1);

      // Live Gateway session path: OSC default-color replies use the same
      // startupInput.onData → connection.input seam after adoptSession.
      const colorQueries = "\u001b]10;?\u001b\\\u001b]11;?\u001b\\";
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "terminal-utf8-e2e",
        seq: colorQueries.length,
        data: colorQueries,
      });
      await expect.poll(async () => (await gateway.getRequests("terminal.input")).length).toBe(2);
      const liveInputs = (await gateway.getRequests("terminal.input")).map(
        ({ params }) => (params as { sessionId: string; data: string }).data,
      );
      console.info(
        `[terminal-utf8-proof] live panel terminal.input after adopt: ${JSON.stringify(liveInputs)} hasFFFD=${liveInputs.join("").includes("\uFFFD")}`,
      );
      expect(liveInputs.join("")).not.toContain("\uFFFD");
      expect(liveInputs).toEqual([
        "\u001b]10;rgb:1b1b/1e1e/2626\u001b\\",
        "\u001b]11;rgb:f7f7/f8f8/fafa\u001b\\",
      ]);

      // Inject split UTF-8 through the adopted tab's Ghostty onData callback when
      // the panel exposes tabs at runtime (TS private is erased for this field).
      const panelInject = await page.evaluate(async () => {
        const panel = document.querySelector("openclaw-terminal-panel") as {
          tabs?: Array<{
            gatewaySessionId?: string;
            controller?: { terminal?: { paste?: (text: string) => void } };
          }>;
        } | null;
        const tab = panel?.tabs?.find((entry) => entry.gatewaySessionId === "terminal-utf8-e2e");
        if (!tab?.controller?.terminal?.paste) {
          return { ok: false as const, reason: "paste-unavailable" };
        }
        tab.controller.terminal.paste("中😀");
        return { ok: true as const };
      });
      if (panelInject.ok) {
        await expect
          .poll(async () => {
            const joined = (await gateway.getRequests("terminal.input"))
              .map(({ params }) => String((params as { data?: string }).data ?? ""))
              .join("");
            return joined.includes("中") && joined.includes("😀") && !joined.includes("\uFFFD");
          })
          .toBe(true);
        const afterPaste = (await gateway.getRequests("terminal.input"))
          .map(({ params }) => String((params as { data?: string }).data ?? ""))
          .join("");
        console.info(
          `[terminal-utf8-proof] live paste after adopt: ${JSON.stringify(afterPaste)} hasFFFD=${afterPaste.includes("\uFFFD")}`,
        );
      } else {
        console.info(
          `[terminal-utf8-proof] live paste skipped (${panelInject.reason}); split-across-adopt covered by Chromium helper + panel unit seam`,
        );
      }

      await page.screenshot({
        path: path.join(utf8ProofArtifactDir, "live-after-adopt.png"),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });

  it("restores a persisted session with no gateway PTY as exited", async () => {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
      ...(deadSessionVideoDir
        ? { recordVideo: { dir: deadSessionVideoDir, size: { width: 1280, height: 800 } } }
        : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: {
            gatewayUrl: string;
            token: string;
          };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: "ws://gateway.example.test",
        token: "test",
      };
      window.sessionStorage.setItem(
        "openclaw.terminal.sessions.v1",
        JSON.stringify(["terminal-dead-after-restart"]),
      );
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      featureMethods: ["terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "replacement-terminal",
          shell: "/bin/bash",
        },
      },
      terminalEnabled: true,
    });

    try {
      const response = await page.goto(`${server.baseUrl}?view=terminal`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("terminal.list");
      await page.waitForTimeout(250);

      if (deadSessionScreenshotPath) {
        await page.screenshot({ path: deadSessionScreenshotPath, fullPage: true });
      }
      const status = page.locator("openclaw-terminal-panel .tabstrip-tab__status");
      await expect.poll(async () => await status.textContent(), { timeout: 5_000 }).toBe("exited");
      expect(await gateway.getRequests("terminal.attach")).toHaveLength(0);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      expect(
        await page.evaluate(() => window.sessionStorage.getItem("openclaw.terminal.sessions.v1")),
      ).toBe("[]");
    } finally {
      await context.close();
    }
  });
});
