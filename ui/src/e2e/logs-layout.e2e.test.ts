import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
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
  it("keeps wrapped filters inside their rows in the macOS dashboard viewport", async () => {
    const proofDir = artifactRoot
      ? path.join(createControlUiE2eArtifactDir("logs-layout", artifactRoot), proofLabel)
      : undefined;
    if (proofDir) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(proofDir ? { recordVideo: { dir: path.join(proofDir, "video"), size: viewport } } : {}),
      },
      async ({ page }) => {
        await page.addInitScript((settingsKey) => {
          localStorage.setItem(settingsKey, JSON.stringify({ textScale: 125, themeMode: "dark" }));
          Object.assign(window, {
            __OPENCLAW_NATIVE_WEB_CHROME__: true,
            __OPENCLAW_NATIVE_HISTORY__: { canGoBack: false, canGoForward: false },
          });
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
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "logs-layout.png"),
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
            streamFlexGrow: stream ? getComputedStyle(stream).flexGrow : "",
            overflow: rows.map((row) => row.scrollHeight - row.clientHeight),
            overlap: rows.map(
              (row, index) =>
                row.getBoundingClientRect().bottom -
                ((rows[index + 1] ?? stream)?.getBoundingClientRect().top ?? Number.NaN),
            ),
          };
        });
        expect(metrics).toMatchObject({ cardDisplay: "flex", streamFlexGrow: "1" });
        expect(metrics.overflow).toHaveLength(2);
        for (const delta of [...metrics.overflow, ...metrics.overlap]) {
          expect(delta).toBeLessThanOrEqual(1);
        }
      },
    );
  });
});
