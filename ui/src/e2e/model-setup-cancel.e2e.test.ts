// Real routing and browser storage; Gateway/provider sign-in is mocked.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  button,
  candidate,
  expectCount,
  expectRequestCounts,
  makeDetection,
  runningStep,
  runningWizard,
  screenshot,
  setupArtifacts,
  setupContext,
} from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI first-run wizard cancellation ownership",
  startServerBeforeBrowser: true,
});
const artifacts = setupArtifacts("model-setup-cancel");
const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
const detection = makeDetection({
  authOptions: [{ id: "provider-login", label: "Provider login", kind: "oauth", featured: true }],
});

const gatewayOptions = {
  featureMethods: [
    "openclaw.setup.detect",
    "openclaw.setup.activate.start",
    "openclaw.setup.auth.start",
    "wizard.next",
    "wizard.cancel",
  ],
  methodResponses: {
    "openclaw.setup.detect": detection,
    "openclaw.setup.auth.start": runningWizard(),
    "wizard.next": runningStep("login", "text", "Complete provider sign-in"),
    "wizard.cancel": { status: "cancelled" },
  },
};

async function openFirstRunWithBackNavigation(page: Page): Promise<void> {
  await page.goto(`${suite.server.baseUrl}settings/connection`);
  await page.locator('.settings-sidebar__item[href="/settings/connection"]').waitFor();
  await evaluateControlUiContext(page, (application) => {
    application.navigate("model-setup", { search: "?firstRun=1" });
  });
  await page.waitForURL((url) => url.pathname === "/settings/model-setup");
}

suite.define(() => {
  it.each(["Yes", "No", "Cancel"] as const)(
    "requires an explicit activation review decision before first-run handoff (%s)",
    async (decision) => {
      await suite.withPage(
        setupContext({ viewport: { width: 1280, height: 800 } }, artifacts.dir),
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "openclaw.setup.detect",
              "openclaw.setup.activate.start",
              "wizard.next",
              "wizard.cancel",
              "openclaw.chat",
            ],
            methodResponses: {
              "openclaw.setup.detect": {
                ...detection,
                candidates: [
                  {
                    kind: "openai-api-key",
                    label: "Selected model",
                    detail: "Saved credentials are available",
                    modelRef: "provider/selected",
                    credentials: true,
                    recommended: true,
                  },
                  candidate("provider-auto:local", "Another model", "local/other", {
                    detail: "Available on this Gateway",
                  }),
                ],
              },
              "openclaw.setup.activate.start": runningWizard("activation-review-session"),
              "wizard.next": {
                sequence: [
                  runningStep(
                    "review",
                    "note",
                    "This changes the selected model route to provider/selected.",
                    { title: "Review model setup" },
                  ),
                  runningStep("consent", "confirm", "Apply the reviewed changes?", {
                    initialValue: false,
                  }),
                  decision === "Yes"
                    ? {
                        done: true,
                        status: "done",
                        modelActivation: { modelRef: "provider/selected" },
                      }
                    : { done: true, status: "cancelled", error: "Model setup was declined." },
                ],
              },
              "wizard.cancel": { status: "cancelled" },
              "openclaw.chat": {
                sessionId: "consent-onboarding",
                reply: "Your reviewed model is ready.",
                action: "none",
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
          await page.locator('[data-candidate-kind="openai-api-key"] button').waitFor();
          expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
          await page.locator('[data-candidate-kind="openai-api-key"] button').click();
          const start = await gateway.waitForRequest("openclaw.setup.activate.start");
          const sessionId = asOptionalRecord(start.params)?.sessionId;
          expect(start.params).toEqual({
            sessionId: expect.any(String),
            kind: "openai-api-key",
            agentId: "main",
            modelRef: "provider/selected",
          });
          const dialog = page.locator("openclaw-modal-dialog");
          await dialog.getByRole("heading", { name: "Review model setup" }).waitFor();
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
          await button(dialog, "Continue").click();
          await dialog.getByText("Apply the reviewed changes?", { exact: true }).waitFor();
          await expect.poll(() => button(dialog, "Yes").isEnabled()).toBe(true);
          const beforeDecision = await gateway.getRequests("wizard.next");
          expect(beforeDecision.map((request) => request.params)).toEqual([
            { sessionId },
            { sessionId, answer: { stepId: "review" } },
          ]);
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
          await screenshot(page, artifacts.dir, `activation-consent-${decision}-review.png`);
          await button(dialog, decision).click();
          if (decision === "Yes") {
            await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
            await page.getByText("Your reviewed model is ready.", { exact: true }).waitFor();
          } else {
            if (decision === "No") {
              await dialog
                .getByRole("alert")
                .filter({ hasText: "Model setup was declined." })
                .waitFor();
              await button(dialog, "Close").click();
            }
            await expectCount(dialog, 0);
            await expect
              .poll(() => page.evaluate((key) => localStorage.getItem(key), receiptKey))
              .toBeNull();
            expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
            expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
            expect(await page.locator(".model-setup-success").count()).toBe(0);
          }
          const answered = await gateway.getRequests("wizard.next");
          expect(answered).toHaveLength(decision === "Cancel" ? 2 : 3);
          if (decision === "Cancel") {
            expect((await gateway.waitForRequest("wizard.cancel")).params).toEqual({ sessionId });
          } else {
            expect(answered[2]?.params).toEqual({
              sessionId,
              answer: { stepId: "consent", value: decision === "Yes" },
            });
          }
          await expectRequestCounts(gateway, {
            "openclaw.setup.activate.start": 1,
            "openclaw.setup.activate": 0,
          });
          for (const method of ["config.set", "config.patch", "config.apply"]) {
            expect(await gateway.getRequests(method)).toHaveLength(0);
          }
          await screenshot(page, artifacts.dir, `activation-consent-${decision}-result.png`);
        },
      );
    },
  );
  it.each(["before return", "after return", "during resume"])(
    "allows sign-in again after Cancel, route exit, and confirmed cancellation (%s)",
    async (acknowledgement) => {
      await suite.withPage(
        setupContext({ viewport: { width: 1280, height: 800 } }),
        async ({ page }) => {
          const gateway = await installMockGateway(page, gatewayOptions);
          await openFirstRunWithBackNavigation(page);
          const signIn = page.locator('[data-auth-choice="provider-login"] button');
          await signIn.click();
          await page.getByText("Complete provider sign-in").waitFor();
          const readReceipt = () => page.evaluate((key) => localStorage.getItem(key), receiptKey);
          expect(await readReceipt()).not.toBeNull();
          await gateway.deferNext("wizard.cancel");
          await button(page.locator("openclaw-modal-dialog"), "Cancel").click();
          await gateway.waitForRequest("wizard.cancel");
          expect(await page.locator("openclaw-modal-dialog").count()).toBe(1);
          // Browser navigation remains available while cancellation is unconfirmed.
          await page.goBack();
          await expectCount(page.locator("openclaw-model-setup-page"), 0);
          expect(await readReceipt()).not.toBeNull();
          if (acknowledgement === "before return") {
            await gateway.resolveDeferred("wizard.cancel");
          } else if (acknowledgement === "during resume") {
            await gateway.deferNext("wizard.next");
          }
          await page.goForward();
          await signIn.waitFor();
          if (acknowledgement === "after return") {
            await page.getByText("Complete provider sign-in").waitFor();
            await gateway.resolveDeferred("wizard.cancel");
          } else if (acknowledgement === "during resume") {
            await gateway.waitForRequest("wizard.next", { after: 1 });
            await gateway.resolveDeferred("wizard.cancel");
          }
          await screenshot(
            page,
            artifacts.dir,
            `cancel-${acknowledgement.replaceAll(" ", "-")}.png`,
            { animations: "disabled" },
          );
          await expect.poll(readReceipt).toBeNull();
          await signIn.click();
          await page.getByText("Complete provider sign-in").waitFor();
          if (acknowledgement === "during resume") {
            const replacementReceipt = await readReceipt();
            await gateway.rejectDeferred("wizard.next", { message: "Old wizard read failed" });
            await page.getByText("Complete provider sign-in").waitFor();
            expect(await readReceipt()).toBe(replacementReceipt);
          }
          await expectRequestCounts(gateway, {
            "openclaw.setup.auth.start": 2,
            "wizard.cancel": 1,
            "openclaw.setup.activate.start": 0,
          });
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
        },
      );
    },
  );
  it("preserves a replacement tab's receipt when the old page confirms cancellation", async () => {
    await suite.withPage(setupContext(), async ({ page, context }) => {
      const gateway = await installMockGateway(page, gatewayOptions);
      await openFirstRunWithBackNavigation(page);
      await page.locator('[data-auth-choice="provider-login"] button').click();
      await page.getByText("Complete provider sign-in").waitFor();
      await gateway.deferNext("wizard.cancel");
      await button(page.locator("openclaw-modal-dialog"), "Cancel").click();
      await gateway.waitForRequest("wizard.cancel");
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(1);
      await page.goBack();
      await expectCount(page.locator("openclaw-model-setup-page"), 0);

      const previousReceipt = await page.evaluate((key) => localStorage.getItem(key), receiptKey);

      const replacement = await context.newPage();
      const nextGateway = await installMockGateway(replacement, {
        ...gatewayOptions,
        methodResponses: {
          ...gatewayOptions.methodResponses,
          "wizard.next": {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "wizard not found",
              details: { code: "WIZARD_NOT_FOUND" },
            },
          },
        },
      });
      await replacement.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
      await replacement.locator('[data-auth-choice="provider-login"] button').waitFor();
      await button(replacement.locator("openclaw-modal-dialog"), "Close").click();
      expect(
        (await nextGateway.getRequests("wizard.next")).map((request) => request.params),
      ).toEqual([{ sessionId: JSON.parse(previousReceipt!).wizard.sessionId }]);
      await expectRequestCounts(nextGateway, {
        "openclaw.setup.auth.start": 0,
        "wizard.cancel": 0,
      });
      await expect
        .poll(() => replacement.evaluate((key) => localStorage.getItem(key), receiptKey))
        .toBeNull();
      await nextGateway.setMethodResponse(
        "wizard.next",
        gatewayOptions.methodResponses["wizard.next"],
      );
      await replacement.locator('[data-auth-choice="provider-login"] button').click();
      await replacement.getByText("Complete provider sign-in").waitFor();
      const receipt = await replacement.evaluate((key) => localStorage.getItem(key), receiptKey);
      expect(receipt).not.toBeNull();
      expect(receipt).not.toBe(previousReceipt);
      await gateway.resolveDeferred("wizard.cancel");
      await page.goForward();
      await page.locator('[data-auth-choice="provider-login"] button').waitFor();
      expect(await replacement.evaluate((key) => localStorage.getItem(key), receiptKey)).toBe(
        receipt,
      );
      await replacement.getByText("Complete provider sign-in").waitFor();
      await expectRequestCounts(nextGateway, {
        "openclaw.setup.auth.start": 1,
        "wizard.cancel": 0,
      });
      expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
      expect(new URL(replacement.url()).pathname).toBe("/settings/model-setup");
    });
  });
});
