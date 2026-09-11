// A real Gateway restart leaves an unfinished checklist with no run; the composer must dismiss it durably.
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:progress-interrupted";
const plan = [
  { step: "Inspect update owner", status: "completed" },
  { step: "Apply update", status: "in_progress" },
  { step: "Verify restart", status: "pending" },
];
let instance: OpenClawTestInstance;
let artifactDir: string;

const suite = createControlUiE2eSuite({
  name: "Interrupted progress dismissal with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    artifactDir = createControlUiE2eArtifactDir("progress-interrupted-dismiss");
    instance = await createOpenClawTestInstance({
      name: "progress-interrupted-dismiss",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: { ownership: "explicit", entries: { main: {} } },
        plugins: { allow: [] },
      },
    });
    try {
      await instance.startGateway();
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
    return {
      baseUrl: `http://127.0.0.1:${instance.port}/`,
      close: () => instance.cleanup(),
    };
  },
});

suite.define(() => {
  it("dismisses an unfinished checklist left by a Gateway restart and keeps it absent", async () => {
    const call = async (method: string, params: Record<string, unknown>) => {
      const args = ["gateway", "call", method, "--json", "--params", JSON.stringify(params)];
      const result = await instance.cli(args);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    await call("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: "Interrupted progress",
    });
    expect((await call("progressCard.put", { sessionKey, plan })).card.revision).toBe(1);

    // The restart is the interruption: durable progress survives, and no run owns it.
    await instance.stopGateway();
    await instance.startGateway();
    expect((await call("progressCard.get", { sessionKey })).card.steps).toEqual(plan);

    const handoff = await instance.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
    const url = new URL(browserUrl);
    url.pathname = "/chat/main/progress-interrupted";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 560, height: 900 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        await page.goto(url.href);
        await waitForControlUiGatewayReady(page);
        const card = page.locator('[data-progress-card-placement="composer"]');
        await card.waitFor({ state: "visible", timeout: 30_000 });
        await expect
          .poll(() => card.locator(".session-progress-card__step--paused").count())
          .toBe(1);
        expect(await card.locator(".session-run-spinner").count()).toBe(0);
        await page.screenshot({ path: path.join(artifactDir, "01-interrupted-card.png") });

        await card.getByRole("button", { name: "Dismiss progress card" }).click();
        await card.waitFor({ state: "detached", timeout: 15_000 });
        expect((await call("progressCard.get", { sessionKey })).card).toBeNull();

        await page.reload();
        await waitForControlUiGatewayReady(page);
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        expect(await card.count()).toBe(0);
        await page.screenshot({ path: path.join(artifactDir, "02-dismissed-after-reload.png") });
      },
    );
  }, 240_000);
});
