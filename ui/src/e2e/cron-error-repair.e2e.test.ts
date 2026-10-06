import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron error repair E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("copies a failed-run prompt and opens a reviewable OpenClaw repair draft", async () => {
    const proofDir = createControlUiE2eArtifactDir("cron-error-repair");
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 950, width: 1280 },
      },
      async ({ context, page }) => {
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          sessionScope: "global",
          methodResponses: {
            "cron.list": {
              jobs: [],
              snapshotRevision: "cron-repair-proof",
              total: 0,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.runs": {
              entries: [
                {
                  ts: Date.UTC(2026, 9, 2, 19, 46),
                  runAtMs: Date.UTC(2026, 9, 2, 19, 46),
                  jobId: "orders4-hls-run5-completion",
                  jobName: "orders4-hls-run5-completion",
                  runId: "run-95",
                  action: "finished",
                  status: "error",
                  error:
                    "cron trigger evaluation failed: ReferenceError: exec is not defined at openclaw-code-mode:user.js:1:9",
                },
                {
                  ts: Date.UTC(2026, 9, 2, 19, 45),
                  jobId: "successful-job",
                  action: "finished",
                  status: "ok",
                  summary: "Done",
                },
              ],
              total: 2,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.getByRole("tab", { name: "Run history", exact: true }).click();
        const failed = page.locator(".cron-run-entry").first();
        const successful = page.locator(".cron-run-entry").last();
        const copy = failed.locator(".cron-run-entry__copy-prompt");
        await copy.waitFor();
        expect(await successful.getByRole("button", { name: "Fix error" }).count()).toBe(0);
        const baselineStyle = await page.addStyleTag({
          content: ".cron-run-entry__repair-actions { display: none !important; }",
        });
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "failed-run-before-desktop.png"),
        });
        await baselineStyle.evaluate((style) => style.remove());
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "failed-run-desktop.png"),
        });

        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await copy.click();
        await failed.getByRole("button", { name: "Prompt copied", exact: true }).waitFor();
        const prompt = await page.evaluate(() => navigator.clipboard.readText());
        expect(prompt).toContain("orders4-hls-run5-completion");
        expect(prompt).toContain("exec is not defined");
        expect(prompt).toContain("source fix");

        await page.setViewportSize({ height: 844, width: 390 });
        await copy.scrollIntoViewIfNeeded();
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "failed-run-phone.png"),
        });

        await failed.getByRole("button", { name: "Fix error", exact: true }).click();
        const draft = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .agent-chat__input textarea',
        );
        await draft.waitFor();
        await expect.poll(() => draft.inputValue()).toContain("run-95");
        expect(await draft.inputValue()).toContain("orders4-hls-run5-completion");
        expect(await draft.inputValue()).not.toContain("exec is not defined");
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "repair-draft-phone.png"),
        });

        for (const method of ["cron.run", "cron.update", "chat.send"]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
      },
    );
  });
});
