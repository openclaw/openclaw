import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI external supervisor update E2E" });
const guidance = {
  version: 1,
  action: "update",
  name: "Example Fleet",
  runFrom: "your deployment host",
  command: 'fleet update --deployment "example<prod>" && fleet restart',
} as const;
const config = { update: { auto: { enabled: false }, channel: "stable" } };
const configResponse = {
  config,
  hash: "external-update-config",
  raw: JSON.stringify(config),
  runtimeConfig: config,
  valid: true,
  issues: [],
};

suite.define(() => {
  it.each(["default", "deployment"])(
    "shows %s guidance for the current no-run external refusal",
    async (label) => {
      const proofDir = createControlUiE2eArtifactDir(`external-supervisor-${label}`);
      const externalSupervisorGuidance = label === "deployment" ? guidance : undefined;
      await suite.withPage(
        {
          locale: "en-US",
          viewport: { width: 1440, height: 1100 },
          permissions: ["clipboard-read", "clipboard-write"],
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            communityInvite: false,
            agentModel: "openai/gpt-5",
            models: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
            updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
            methodResponses: {
              "config.get": configResponse,
              "update.status": { activeRun: null, lastRun: null, externalSupervisorGuidance },
              "update.run": {
                runId: null,
                ok: false,
                code: "external-supervisor-update-required",
                externalSupervisorGuidance,
                result: { status: "skipped", reason: "external-supervisor-update-required" },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/updates`);
          await gateway.waitForRequest("config.get");
          await page.getByRole("button", { name: "Update Gateway…", exact: true }).click();
          const dialog = page.locator("openclaw-modal-dialog");
          await dialog.getByRole("button", { name: "Update and restart", exact: true }).click();
          await gateway.waitForRequest("update.run");
          await dialog.getByText("external-supervisor-update-required", { exact: false }).waitFor();
          const copy = dialog.locator(".external-supervisor-guidance");
          if (externalSupervisorGuidance) {
            await copy.waitFor();
            expect(await copy.textContent()).toContain("Managed by Example Fleet.");
            expect(await copy.textContent()).toContain("Run from: your deployment host");
            expect(await copy.locator("code").textContent()).toBe(guidance.command);
            expect(await copy.locator("prod").count()).toBe(0);
          } else {
            expect(await copy.count()).toBe(0);
          }
          const target = externalSupervisorGuidance
            ? copy
            : dialog.getByText("external-supervisor-update-required", { exact: false });
          const frame = await takeControlUiScreenshotFrame(
            page,
            dialog.locator(".oc-dialog"),
            [target],
            {
              elements: [target],
              animations: "disabled",
            },
          );
          await writeFile(path.join(proofDir, "dialog-clean.png"), frame.png);
          const annotations = {
            viewport: page.viewportSize()!,
            scale: await page.evaluate(() => window.devicePixelRatio),
            annotations: [
              {
                kind: "outline" as const,
                rect: frame.elements[0]!.bounds,
                text: externalSupervisorGuidance
                  ? "Deployment-owned literal command"
                  : "Generic supervisor instructions",
                labelAt: { x: 980, y: 180 },
                color: "#276F94",
              },
            ],
          };
          await writeFile(
            path.join(proofDir, "dialog-annotations.json"),
            JSON.stringify(annotations),
          );
          await writeFile(
            path.join(proofDir, "dialog-annotated.png"),
            await rasterizeProofAnnotations(suite.browser, { ...annotations, image: frame.png }),
          );
          if (externalSupervisorGuidance) {
            await copy.getByRole("button", { name: "Copy update command", exact: true }).click();
            await expect
              .poll(() => page.evaluate(() => navigator.clipboard.readText()))
              .toBe(guidance.command);
          }
          await dialog
            .locator("openclaw-modal-actions")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await dialog.waitFor({ state: "detached" });
          const settings = page.locator("#config-section-update");
          await settings
            .getByText("external-supervisor-update-required", { exact: false })
            .waitFor();
          if (externalSupervisorGuidance) {
            expect(await settings.locator(".external-supervisor-guidance code").textContent()).toBe(
              guidance.command,
            );
          }
          const attempt = externalSupervisorGuidance
            ? settings.locator(".settings-section").filter({
                has: page.locator(".external-supervisor-guidance"),
              })
            : settings.locator(".settings-section").filter({
                hasText: "external-supervisor-update-required",
              });
          const settingsFrame = await takeControlUiScreenshotFrame(
            page,
            attempt,
            [externalSupervisorGuidance ? attempt.locator("code").first() : attempt],
            { animations: "disabled", scrollTo: attempt },
          );
          await writeFile(path.join(proofDir, "settings-clean.png"), settingsFrame.png);
          expect(await gateway.getRequests("update.run")).toHaveLength(1);
          expect(await gateway.getRequests("update.runs.get")).toHaveLength(0);
          expect(await gateway.getRequests("update.report")).toHaveLength(0);
        },
      );
    },
  );
});
