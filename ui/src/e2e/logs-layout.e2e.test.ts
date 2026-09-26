import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI logs native app layout E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("logs-layout", artifactRoot)
    : undefined;
});
const proofLabel = process.env.OPENCLAW_UI_E2E_PROOF_LABEL?.trim() || "logs-layout";
const viewport = { height: 584, width: 863 };

const logLines = Array.from({ length: 40 }, (_value, index) =>
  JSON.stringify({
    "0": JSON.stringify({ subsystem: "native-layout-e2e" }),
    "1": `log line ${index + 1}`,
    time: new Date(Date.UTC(2026, 6, 21, 12, 0, index)).toISOString(),
    _meta: { logLevelName: "info" },
  }),
);

suite.define(() => {
  it.each([
    { name: "fresh portrait", width: 390, height: 844, resize: false },
    { name: "desktop navigation resized to landscape", width: 844, height: 390, resize: true },
  ])("keeps the last log entry reachable on $name", async ({ width, height, resize }) => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: resize ? { width: 1440, height: 900 } : { width, height },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "logs.tail": {
              cursor: logLines.length,
              file: "/tmp/openclaw/isolated-gateway/logs/mobile-layout-reproduction/diagnostics/openclaw-2026-09-18-session.log",
              lines: logLines,
              reset: true,
            },
          },
        });
        if (resize) {
          await page.goto(`${suite.server.baseUrl}settings/general`);
          await page.locator('.settings-sidebar__item[href="/logs"]').click();
          await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);
          await page.setViewportSize({ width, height });
        } else {
          await page.goto(`${suite.server.baseUrl}logs`);
        }
        await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);
        const follow = page.locator("wa-switch.settings-toggle");
        await follow.focus();
        await follow.press("Space");
        await expect
          .poll(() => follow.evaluate((element) => Reflect.get(element, "checked")))
          .toBe(false);
        await follow.press("Space");
        await expect
          .poll(() => follow.evaluate((element) => Reflect.get(element, "checked")))
          .toBe(true);
        const stream = page.locator(".log-stream");
        await expect
          .poll(() =>
            stream.evaluate(
              (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
            ),
          )
          .toBeLessThan(2);

        // Wheel over the page gutter, outside the independently scrolling stream.
        const content = await page.locator(".content").boundingBox();
        if (!content) {
          throw new Error("Logs content is not visible");
        }
        await page.mouse.move(content.x + 2, content.y + 20);
        await page.mouse.wheel(0, height * 2);
        const lastRow = page.locator(".log-row").last();
        await expect
          .poll(() => lastRow.evaluate((row) => row.getBoundingClientRect().bottom))
          .toBeLessThanOrEqual(height);
        const rowLayout = await lastRow.evaluate((row) => {
          const time = row.querySelector(".log-time")!.getBoundingClientRect();
          const level = row.querySelector(".log-level")!.getBoundingClientRect();
          const message = row.querySelector(".log-message")!.getBoundingClientRect();
          return {
            timeLeft: time.left,
            messageLeft: message.left,
            levelBottom: level.bottom,
            messageTop: message.top,
          };
        });
        expect(rowLayout.messageLeft).toBe(rowLayout.timeLeft);
        expect(rowLayout.messageTop).toBeGreaterThanOrEqual(rowLayout.levelBottom);
      },
    );
  });

  it("keeps wrapped filters inside their rows in the macOS dashboard viewport", async () => {
    if (artifactDir) {
      await mkdir(path.join(artifactDir, proofLabel, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(artifactDir
          ? { recordVideo: { dir: path.join(artifactDir, proofLabel, "video"), size: viewport } }
          : {}),
      },
      async ({ page }) => {
        await page.addInitScript((settingsKey) => {
          localStorage.setItem(settingsKey, JSON.stringify({ textScale: 125, themeMode: "dark" }));
          const nativeWindow = window as Window & {
            __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
            __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
          };
          nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
          nativeWindow["__OPENCLAW_NATIVE_HISTORY__"] = {
            canGoBack: false,
            canGoForward: false,
          };
          const stamp = () =>
            document.documentElement.classList.add(
              "openclaw-native-macos",
              "openclaw-native-web-chrome",
            );
          if (document.documentElement) {
            stamp();
          } else {
            document.addEventListener("DOMContentLoaded", stamp);
          }
        }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
        await installMockGateway(page, {
          methodResponses: {
            "logs.tail": {
              cursor: logLines.length,
              file: "/tmp/openclaw/openclaw-2026-07-21.log",
              lines: logLines,
              reset: true,
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/general`);
        await page.locator('.settings-sidebar__item[href="/logs"]').click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/logs");
        await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, proofLabel, "logs-layout.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".logs-card"), [
              page.locator(".log-row").first(),
            ]),
          );
        }

        const metrics = await page.locator(".logs-card").evaluate((card) => {
          const rows = [...card.querySelectorAll<HTMLElement>(":scope > .settings-row")];
          const stream = card.querySelector<HTMLElement>(":scope > .log-stream");
          return {
            cardDisplay: getComputedStyle(card).display,
            rows: rows.map((row) => {
              const bounds = row.getBoundingClientRect();
              return {
                bottom: bounds.bottom,
                clientHeight: row.clientHeight,
                scrollHeight: row.scrollHeight,
                top: bounds.top,
              };
            }),
            streamFlexGrow: stream ? getComputedStyle(stream).flexGrow : "",
            streamTop: stream?.getBoundingClientRect().top ?? Number.NaN,
          };
        });

        expect(metrics.cardDisplay).toBe("flex");
        expect(metrics.streamFlexGrow).toBe("1");
        expect(metrics.rows).toHaveLength(2);
        const [firstRow, secondRow] = metrics.rows;
        if (!firstRow || !secondRow) {
          throw new Error(`Expected two log control rows, received ${metrics.rows.length}.`);
        }
        for (const row of metrics.rows) {
          expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight + 1);
        }
        expect(firstRow.bottom).toBeLessThanOrEqual(secondRow.top + 1);
        expect(secondRow.bottom).toBeLessThanOrEqual(metrics.streamTop + 1);
      },
    );
  });
});
