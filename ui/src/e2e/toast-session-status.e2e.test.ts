import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const stage = process.env.OPENCLAW_TOAST_PROOF_STAGE ?? "after";

suite.define(() => {
  it.each([
    { status: "ok", label: "Completed", tone: "--ok", width: 1280, mode: "dark" },
    { status: "error", label: "Failed", tone: "--danger", width: 1280, mode: "dark" },
    { status: "timeout", label: "Timed out", tone: "--danger", width: 390, mode: "light" },
    {
      status: "error",
      label: "Stopped",
      tone: "--muted",
      width: 390,
      mode: "dark",
    },
  ] as const)("shows $label after a background run and opens its session", async (outcome) => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: outcome.width, height: 900 },
    });
    const page = await context.newPage();
    const key = "agent:main:dashboard:toast-status";
    const runId = "toast-status-run";
    const gateway = await installMockGateway(page, {
      agentModel: "example/demo-model",
      models: [{ id: "demo-model", name: "Demo model", provider: "example" }],
      methodResponses: {
        "config.get": configResponse(
          { theme: "absolutely", themeMode: outcome.mode },
          "toast-status",
        ),
        "sessions.create": {
          key,
          entry: { sessionId: "toast-status-session", updatedAt: Date.now() },
          runId,
          runStarted: true,
        },
      },
    });
    try {
      await page.goto(suite.server.baseUrl + "new");
      await gateway.deferNext("agent.wait");
      const composer = page.locator(".new-session-page__message");
      await composer.fill("Fix issue");
      await composer.press("Control+Enter");
      await expect(gateway.waitForRequest("agent.wait")).resolves.toMatchObject({
        params: { runId, timeoutMs: 30_000 },
      });
      await expect.poll(() => composer.inputValue()).toBe("");
      await composer.fill("Plan the next task");
      await gateway.resolveDeferred("agent.wait", {
        status: outcome.status,
        ...(outcome.label === "Stopped" ? { stopReason: "rpc" } : {}),
        endedAt: Date.now(),
        runId,
      });
      const toast = page.locator(".app-toast--avatar");
      const open = toast.getByRole("link", { name: "Open session", exact: true });
      await open.waitFor();
      await open.focus();
      if (capture) {
        const dir = createControlUiE2eArtifactDir("toast-session-status-" + stage);
        const frame = await takeControlUiScreenshotFrame(page, toast, [open], {
          animations: "disabled",
          elements: [toast],
        });
        const name = outcome.label.toLowerCase().replaceAll(" ", "-");
        await writeFile(path.join(dir, name + ".png"), frame.png);
        await writeFile(path.join(dir, name + "-toast.png"), frame.elements[0]!.png);
      }
      expect(await toast.locator(".app-toast__description").textContent()).toBe(outcome.label);
      const ink = await toast.evaluate((element, token) => {
        const description = element.querySelector(".app-toast__description")!;
        const actual = getComputedStyle(description).color;
        const probe = document.createElement("span");
        probe.style.color = "var(" + token + ")";
        element.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return { actual, expected };
      }, outcome.tone);
      expect(ink.actual).toBe(ink.expected);
      expect(await toast.locator(".app-toast__icon").count()).toBe(0);
      expect(await composer.inputValue()).toBe("Plan the next task");
      await open.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
    } finally {
      await context.close();
    }
  });
});
