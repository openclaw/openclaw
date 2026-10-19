// Real browser flow with a mocked Gateway; no Ollama server or model is used.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activationFailure,
  button,
  candidate,
  expectCount,
  expectFocused,
  expectRequestCounts,
  makeDetection,
  runningStep,
  runningWizard,
  setupContext,
  setupRpc as rpc,
} from "./model-setup-fixtures.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Model Setup activation feedback mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

async function viewportIntersection(target: Locator): Promise<number> {
  return target.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve(entry!.intersectionRatio);
        });
        observer.observe(element);
      }),
  );
}

suite.define(() => {
  it("bootstraps chat after leaving Models discovery despite unavailable auth status", async () => {
    await suite.withPage(
      setupContext({ viewport: { width: 1280, height: 800 } }),
      async ({ page }) => {
        const ready = "The existing chat is ready.";
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installSetupGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, rpc.detect],
          heldMethods: [rpc.detect],
          historyMessages: [{ role: "assistant", content: [{ type: "text", text: ready }] }],
          methodResponses: {
            [rpc.detect]: makeDetection(),
            "models.authStatus": {
              __mockError: {
                code: "UNAVAILABLE",
                message: "Model authentication status is unavailable.",
                retryable: false,
              },
            },
          },
        });
        await openModelSetup(page, suite.server.baseUrl);
        await gateway.waitForRequest(rpc.detect);
        await page.locator(".model-setup__loading").waitFor();
        const initialContext = await getControlUiContextHandle(page);
        await page.waitForFunction(
          (context) => context.gateway.snapshot.client?.recoveryScopeReady,
          initialContext,
        );
        const connectionOwner = await initialContext.evaluateHandle((context) => {
          const client = context.gateway.snapshot.client!;
          return { client, recoveryScope: client.recoveryScope };
        });
        await initialContext.dispose();
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        await button(page.locator(".model-setup-discovery"), "Close").click();
        await page.getByRole("button", { name: "Back to app" }).click();
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("models.authStatus");
        await page.getByText(ready, { exact: true }).waitFor();

        // Revisit before the old reply: the abandoned loader must not own the new request.
        await page.goBack();
        await page.locator("[data-models-login-discover]").click();
        await page.getByRole("heading", { name: "On this Gateway", exact: true }).waitFor();
        await gateway.waitForRequest(rpc.detect, { after: 1 });
        await gateway.resolveDeferred(rpc.detect);
        await page
          .locator(".model-setup__intro")
          .getByRole("button", { name: "Check again" })
          .waitFor();
        expect(await gateway.getRequests(rpc.detect)).toHaveLength(2);
        await button(page.locator(".model-setup-discovery"), "Close").click();
        await page.getByRole("button", { name: "Back to app" }).click();
        await page.getByText(ready, { exact: true }).waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("Continue after setup.");
        await button(page, "Send message").click();
        const sent = await gateway.waitForRequest("chat.send");
        const params = asOptionalRecord(sent.params);
        expect(params).toMatchObject({
          message: "Continue after setup.",
          idempotencyKey: expect.any(String),
        });
        await gateway.emitChatFinal({
          runId: String(params?.idempotencyKey),
          text: "Chat remains usable.",
        });
        await page.getByRole("paragraph").filter({ hasText: "Chat remains usable." }).waitFor();
        expect(await gateway.getRequests("connect")).toHaveLength(1);
        const currentContext = await getControlUiContextHandle(page);
        expect(
          await currentContext.evaluate((context, { client, recoveryScope }) => {
            return {
              sameClient: context.gateway.snapshot.client === client,
              recoveryReady: client.recoveryScopeReady,
              sameRecoveryScope: client.recoveryScope === recoveryScope,
            };
          }, connectionOwner),
        ).toEqual({ sameClient: true, recoveryReady: true, sameRecoveryScope: true });
        await currentContext.dispose();
        await connectionOwner.dispose();
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it.each([
    ["manual", 1080],
    ["candidate", 1280],
  ] as const)(
    "shows %s activation feedback in a modal and restores focus after closing",
    async (entry, width) => {
      await suite.withPage(setupContext({ viewport: { width, height: 720 } }), async ({ page }) => {
        const installGateway = entry === "manual" ? installMockGateway : installSetupGateway;
        const gateway = await installGateway(page, {
          featureMethods: [rpc.detect, rpc.activate, rpc.next],
          methodResponses: {
            [rpc.next]: activationFailure("HTTP 401", "auth"),
            [rpc.detect]: makeDetection({
              candidates:
                entry === "candidate"
                  ? Array.from({ length: 5 }, (_, i) =>
                      candidate("provider-auto:local", `Local ${i + 1}`, `local/model-${i + 1}`),
                    )
                  : [],
              manualProviders: [{ id: "openai", label: "OpenAI", brandId: "openai" }],
              authOptions: ["OpenAI", "OpenRouter", "xAI"].map((label) => ({
                id: label,
                label,
                kind: "oauth",
                featured: true,
              })),
            }),
          },
        });
        if (entry === "manual") {
          await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        } else {
          await openModelSetup(page, suite.server.baseUrl);
        }
        const setup = page.locator(".model-setup");
        const input = setup.locator('input[type="password"]');
        const scrollContainer = page.locator(
          entry === "manual" ? ".content" : ".model-setup-discovery > .model-setup-wizard__body",
        );
        await setup.locator(".model-setup-provider-select__trigger").click();
        await setup.locator('[data-manual-provider="openai"]').click();
        await input.fill("invalid-test-key");
        const activate =
          entry === "manual"
            ? setup.getByRole("button", { name: "Connect & verify" })
            : setup.locator("[data-candidate-kind]").last().getByRole("button");
        await activate.scrollIntoViewIfNeeded();
        expect(await viewportIntersection(setup.locator(".model-setup__intro"))).toBe(0);
        expect(await scrollContainer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await gateway.deferNext(rpc.activate);
        await activate.click();
        const request = await gateway.waitForRequest(rpc.activate);
        expect(request.params).toMatchObject(
          entry === "manual"
            ? { kind: "api-key", authChoice: "openai", apiKey: "invalid-test-key" }
            : { kind: "provider-auto:local", modelRef: "local/model-5" },
        );
        const dialog = page.locator("openclaw-modal-dialog");
        const progress = dialog.getByRole("status");
        await progress.waitFor();
        expect(await progress.count()).toBe(1);
        expect.soft(await viewportIntersection(progress)).toBeGreaterThan(0.99);

        await gateway.resolveDeferred(rpc.activate, runningWizard("activation-session"));
        const failure = dialog.getByRole("alert");
        await failure.waitFor();
        expect(await failure.count()).toBe(1);
        expect(await failure.textContent()).toContain("HTTP 401");
        expect.soft(await viewportIntersection(failure)).toBeGreaterThan(0.99);
        expect(await page.locator("openclaw-model-setup-page").textContent()).not.toContain(
          "invalid-test-key",
        );

        await button(dialog, "Close").click();
        await expectCount(dialog, entry === "manual" ? 0 : 1);
        await expectCount(dialog.getByRole("alert"), 0);
        await expectCount(page.locator(".model-setup-discovery"), entry === "manual" ? 0 : 1);
        await expectFocused(activate);
        await scrollContainer.evaluate((element) =>
          element.scrollTo({ top: element.scrollHeight, behavior: "instant" }),
        );
        await input.fill("another-invalid-test-key");
        expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(await gateway.getRequests(rpc.activate)).toHaveLength(1);
      });
    },
  );

  it.each(["provider timeout", "request rejection"])(
    "shows pending and %s for a prepared idle model absent from detection",
    async (outcome) => {
      await suite.withPage(
        setupContext({ viewport: { width: 1080, height: 480 } }),
        async ({ page }) => {
          const timeoutMessage = "The model did not finish the setup test in time.";
          const gateway = await installMockGateway(page, {
            featureMethods: [rpc.detect, rpc.prepare, rpc.activate, rpc.next],
            methodResponses: {
              [rpc.detect]: makeDetection({
                prepareOptions: [
                  { id: "ollama", label: "Ollama", actionLabel: "Choose connection" },
                ],
              }),
              [rpc.prepare]: runningWizard("idle-model-prepare"),
              [rpc.next]: {
                sequence: [
                  runningStep("ollama-mode", "select", "Ollama mode", {
                    options: [{ value: "local-only", label: "Local only" }],
                  }),
                  runningStep("ollama-base-url", "text", "Ollama base URL", {
                    initialValue: "http://127.0.0.1:11434",
                  }),
                  { done: true, status: "done", preparedModelRef: "ollama/qwen3:4b" },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
          const setup = page.locator(".model-setup");
          const choose = setup.getByRole("button", { name: "Choose connection" });
          await choose.click();
          expect((await gateway.waitForRequest(rpc.prepare)).params).toMatchObject({
            authChoice: "ollama",
          });
          await button(page, "Local only").click();
          await expect
            .poll(() => page.getByLabel("Ollama base URL").inputValue())
            .toBe("http://127.0.0.1:11434");
          await gateway.deferNext(rpc.activate);
          await button(page, "Submit").click();
          expect((await gateway.waitForRequest(rpc.activate)).params).toEqual({
            kind: "provider-auto:ollama",
            modelRef: "ollama/qwen3:4b",
            agentId: "main",
            sessionId: expect.any(String),
          });
          await expectCount(page.locator("openclaw-modal-dialog"), 1);
          expect(await setup.locator("[data-candidate-kind]").count()).toBe(0);
          expect(await choose.isDisabled()).toBe(true);
          const dialog = page.locator("openclaw-modal-dialog");
          const progress = dialog.getByRole("status");
          await progress.waitFor();
          expect.soft(await viewportIntersection(progress)).toBeGreaterThan(0.99);
          expect.soft(await progress.count()).toBe(1);
          if (await progress.count()) {
            expect(await progress.isVisible()).toBe(true);
            expect(await progress.textContent()).toContain("Checking your model setup");
          }

          if (outcome === "provider timeout") {
            await gateway.setMethodResponse(rpc.next, activationFailure(timeoutMessage, "timeout"));
            await gateway.resolveDeferred(rpc.activate, runningWizard("activation-session"));
          } else {
            await gateway.rejectDeferred(rpc.activate, {
              code: "UNAVAILABLE",
              message: timeoutMessage,
            });
            // A transport rejection leaves first-run intent unresolved; it must
            // not enable repeating a mutation whose result is still uncertain.
            await setup.getByText(/The previous activation is unresolved/u).waitFor();
            expect(await choose.isDisabled()).toBe(true);
          }
          await expectCount(dialog.getByRole("status"), 0);
          const failure = dialog.getByRole("alert").filter({ hasText: timeoutMessage });
          expect.soft(await viewportIntersection(failure)).toBeGreaterThan(0.99);
          expect(await failure.count()).toBe(1);
          expect(await failure.isVisible()).toBe(true);
          expect((await failure.textContent())?.trim()).toBe(timeoutMessage);
          await button(dialog, "Close").click();
          await expectCount(dialog, 0);
          expect(await choose.isEnabled()).toBe(outcome === "provider timeout");
          expect(await setup.locator("[data-candidate-kind]").count()).toBe(0);
          expect(await page.locator(".model-setup-success").count()).toBe(0);
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
          await expectRequestCounts(gateway, { [rpc.activate]: 1, "config.set": 0 });
          const next = await gateway.getRequests(rpc.next);
          expect(next).toHaveLength(outcome === "provider timeout" ? 4 : 3);
          expect(next[1]?.params).toMatchObject({
            answer: { stepId: "ollama-mode", value: "local-only" },
          });
          expect(next[2]?.params).toMatchObject({
            answer: { stepId: "ollama-base-url", value: "http://127.0.0.1:11434" },
          });
        },
      );
    },
  );
});
