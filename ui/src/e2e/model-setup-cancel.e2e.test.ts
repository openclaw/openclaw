// Real routing and browser storage; Gateway/provider sign-in is mocked.
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI first-run wizard cancellation ownership",
  startServerBeforeBrowser: true,
});
const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("model-setup-cancel", artifactRoot)
    : undefined;
});
const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
const detection = {
  candidates: [],
  manualProviders: [],
  authOptions: [{ id: "provider-login", label: "Provider login", kind: "oauth", featured: true }],
  workspace: "/tmp/openclaw-e2e",
  setupComplete: false,
};

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
    "openclaw.setup.auth.start": { done: false, status: "running" },
    "wizard.next": {
      done: false,
      status: "running",
      step: { id: "login", type: "text", message: "Complete provider sign-in" },
    },
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
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 800 },
          ...(artifactDir
            ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 800 } } }
            : {}),
        },
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
                  {
                    kind: "provider-auto:local",
                    label: "Another model",
                    detail: "Available on this Gateway",
                    modelRef: "local/other",
                    credentials: true,
                    recommended: false,
                  },
                ],
              },
              "openclaw.setup.activate.start": {
                sessionId: "activation-review-session",
                done: false,
                status: "running",
              },
              "wizard.next": {
                sequence: [
                  {
                    done: false,
                    status: "running",
                    step: {
                      id: "review",
                      type: "note",
                      title: "Review model setup",
                      message: "This changes the selected model route to provider/selected.",
                    },
                  },
                  {
                    done: false,
                    status: "running",
                    step: {
                      id: "consent",
                      type: "confirm",
                      message: "Apply the reviewed changes?",
                      initialValue: false,
                    },
                  },
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
          await dialog.getByRole("button", { name: "Continue", exact: true }).click();
          await dialog.getByText("Apply the reviewed changes?", { exact: true }).waitFor();
          await expect
            .poll(() => dialog.getByRole("button", { name: "Yes", exact: true }).isEnabled())
            .toBe(true);
          const beforeDecision = await gateway.getRequests("wizard.next");
          expect(beforeDecision.map((request) => request.params)).toEqual([
            { sessionId },
            { sessionId, answer: { stepId: "review" } },
          ]);
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
          if (artifactDir) {
            await page.screenshot({
              path: path.join(artifactDir, `activation-consent-${decision}-review.png`),
            });
          }
          await dialog.getByRole("button", { name: decision, exact: true }).click();
          if (decision === "Yes") {
            await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
            await page.getByText("Your reviewed model is ready.", { exact: true }).waitFor();
          } else {
            if (decision === "No") {
              await dialog
                .getByRole("alert")
                .filter({ hasText: "Model setup was declined." })
                .waitFor();
              await dialog.getByRole("button", { name: "Close", exact: true }).click();
            }
            await expect.poll(() => dialog.count()).toBe(0);
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
          expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(1);
          expect(await gateway.getRequests("openclaw.setup.activate")).toHaveLength(0);
          for (const method of ["config.set", "config.patch", "config.apply"]) {
            expect(await gateway.getRequests(method)).toHaveLength(0);
          }
          if (artifactDir) {
            await page.screenshot({
              path: path.join(artifactDir, `activation-consent-${decision}-result.png`),
            });
          }
        },
      );
    },
  );
  it.each(["before return", "after return", "during resume"])(
    "allows sign-in again after Cancel, route exit, and confirmed cancellation (%s)",
    async (acknowledgement) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, gatewayOptions);
          await openFirstRunWithBackNavigation(page);
          const signIn = page.locator('[data-auth-choice="provider-login"] button');
          await signIn.click();
          await page.getByText("Complete provider sign-in").waitFor();
          const readReceipt = () => page.evaluate((key) => localStorage.getItem(key), receiptKey);
          expect(await readReceipt()).not.toBeNull();
          await gateway.deferNext("wizard.cancel");
          await page
            .locator("openclaw-modal-dialog")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await gateway.waitForRequest("wizard.cancel");
          expect(await page.locator("openclaw-modal-dialog").count()).toBe(1);
          // Browser navigation remains available while cancellation is unconfirmed.
          await page.goBack();
          await expect.poll(() => page.locator("openclaw-model-setup-page").count()).toBe(0);
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
          if (artifactDir) {
            await page.screenshot({
              path: path.join(artifactDir, `cancel-${acknowledgement.replaceAll(" ", "-")}.png`),
              animations: "disabled",
            });
          }
          await expect.poll(readReceipt).toBeNull();
          await signIn.click();
          await page.getByText("Complete provider sign-in").waitFor();
          if (acknowledgement === "during resume") {
            const replacementReceipt = await readReceipt();
            await gateway.rejectDeferred("wizard.next", { message: "Old wizard read failed" });
            await page.getByText("Complete provider sign-in").waitFor();
            expect(await readReceipt()).toBe(replacementReceipt);
          }
          expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(2);
          expect(await gateway.getRequests("wizard.cancel")).toHaveLength(1);
          expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
        },
      );
    },
  );
  it("preserves a replacement tab's receipt when the old page confirms cancellation", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block" },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, gatewayOptions);
        await openFirstRunWithBackNavigation(page);
        await page.locator('[data-auth-choice="provider-login"] button').click();
        await page.getByText("Complete provider sign-in").waitFor();
        await gateway.deferNext("wizard.cancel");
        await page
          .locator("openclaw-modal-dialog")
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await gateway.waitForRequest("wizard.cancel");
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(1);
        await page.goBack();
        await expect.poll(() => page.locator("openclaw-model-setup-page").count()).toBe(0);

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
        await replacement
          .locator("openclaw-modal-dialog")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        expect(
          (await nextGateway.getRequests("wizard.next")).map((request) => request.params),
        ).toEqual([{ sessionId: JSON.parse(previousReceipt!).wizard.sessionId }]);
        expect(await nextGateway.getRequests("openclaw.setup.auth.start")).toHaveLength(0);
        expect(await nextGateway.getRequests("wizard.cancel")).toHaveLength(0);
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
        expect(await nextGateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
        expect(await nextGateway.getRequests("wizard.cancel")).toHaveLength(0);
        expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
        expect(new URL(replacement.url()).pathname).toBe("/settings/model-setup");
      },
    );
  });
});
