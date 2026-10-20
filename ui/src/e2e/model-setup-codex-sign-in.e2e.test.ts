// Renders detected-Codex activation responses through the real Model Setup UI.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import * as setup from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Detected Codex guided sign-in",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each(["before", "after"] as const)(
    "renders detected Codex activation %s guided sign-in",
    async (state) => {
      const artifacts = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
        ? createControlUiE2eArtifactDir(
            "codex-sign-in-" + state,
            process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
          )
        : undefined;
      await suite.withPage(
        setup.setupContext({
          viewport: { width: 1280, height: 900 },
          colorScheme: "light",
          reducedMotion: "reduce",
        }),
        async ({ page }) => {
          const gateway = await installSetupGateway(page, {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "openclaw.setup.detect",
              "openclaw.setup.activate.start",
              "wizard.next",
            ],
            methodResponses: {
              "openclaw.setup.detect": setup.makeDetection({
                candidates: [
                  setup.candidate("codex-cli", "Codex", "openai/default", {
                    brandId: "openai",
                    detail: "installed; ChatGPT login found",
                  }),
                ],
                setupComplete: true,
              }),
              "openclaw.setup.activate.start": setup.runningWizard("codex-sign-in"),
              "wizard.next":
                state === "before"
                  ? setup.activationFailure('No API key found for provider "openai".', "auth")
                  : {
                      sequence: [
                        setup.runningStep("scope", "note", "Scope: System / agent", {
                          executor: "client",
                        }),
                        setup.runningStep(
                          "device-code",
                          "progress",
                          "Sign in to connect OpenAI to OpenClaw.",
                          {
                            executor: "gateway",
                            title: "OpenAI device code",
                            externalUrl: "https://example.com/device",
                            deviceCode: {
                              code: "DEMO-1234",
                              expiresInMinutes: 15,
                              message: "Enter this one-time code on the sign-in page.",
                            },
                          },
                        ),
                        setup.activated("openai/default"),
                      ],
                    },
            },
          });
          await openModelSetup(page, suite.server.baseUrl);
          if (state === "after") {
            await gateway.deferNext("wizard.next", { answer: { stepId: "scope" } });
          }
          await page.locator('[data-candidate-kind="codex-cli"] button').click();
          expect(
            (await gateway.waitForRequest("openclaw.setup.activate.start")).params,
          ).toMatchObject({ kind: "codex-cli" });
          if (state === "after") {
            await page.getByRole("button", { name: "Continue", exact: true }).click();
            await gateway.waitForRequest("wizard.next", { match: { answer: { stepId: "scope" } } });
            await gateway.deferNext("wizard.next");
            await gateway.resolveDeferred("wizard.next");
            await page.getByText("DEMO-1234", { exact: true }).waitFor();
            await page.getByRole("link", { name: "Open sign-in" }).waitFor();
            await page.getByRole("button", { name: "Cancel", exact: true }).waitFor();
          } else {
            await page
              .getByText('No API key found for provider "openai".', { exact: true })
              .waitFor();
          }
          if (artifacts) {
            await writeFile(
              path.join(artifacts, state + ".png"),
              await takeControlUiViewportScreenshot(page, page.locator(".model-setup-wizard"), []),
            );
          }
          if (state === "after") {
            await gateway.resolveDeferred("wizard.next");
            await page.getByRole("heading", { name: "Connection verified" }).waitFor();
          }
        },
      );
    },
  );
});
