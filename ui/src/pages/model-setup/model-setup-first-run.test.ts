/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { WizardNextResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  clearFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";
import {
  missingWizardError,
  waitForOnboarding,
  waitForElement,
  waitForText,
  pageButton,
  activated,
  mockRequests,
  useFirstRunFixtures,
  pendingReceipt,
  modalButton,
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountDetection,
  reconnectGateway,
  requestParameters,
  runningStep,
  authButton,
  authOption,
  waitForModelSetupDetection,
} from "./model-setup-first-run.test-support.ts";
import { MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";
import { unmountModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

describe("ModelSetupPage first-run inference", () => {
  useFirstRunFixtures("durable-device-private-key-for-testing", true);
  it("does not offer verification when the Gateway does not advertise it", async () => {
    const { context, client, request, snapshot } = createFirstRunContext();
    snapshot.hello.features.methods = snapshot.hello.features.methods.filter(
      (method) => method !== "openclaw.setup.verify",
    );

    const { page } = await mountDetection(context, client, {
      configuredModel: "openai/existing",
      setupComplete: true,
    });

    expect(page.querySelector(".model-setup__recovery .btn.primary")).toBeNull();
    expect(page.textContent).not.toContain("Continue setup");
    expect(request).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("repairs definitively rejected setup with a different credentialed candidate", async () => {
    const { context, client, request } = createFirstRunContext();
    mockRequests(request, {
      "openclaw.setup.activate.start": (params) =>
        params !== null &&
        typeof params === "object" &&
        "modelRef" in params &&
        params.modelRef === "openai/existing"
          ? {
              done: true,
              status: "error",
              error: "The saved login expired",
              activationRejection: { disposition: "rejected-before-promotion", status: "auth" },
            }
          : activated("anthropic/replacement"),
    });

    const { page } = await mountDetection(context, client, {
      configuredModel: "openai/existing",
      setupComplete: true,
      candidates: [
        candidate("saved-auth:expired", "openai/existing", true),
        candidate("anthropic-api-key", "anthropic/replacement", true),
      ],
    });

    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "saved-auth:expired");
    await waitForText(page, "The saved login expired");
    expect(request).toHaveBeenCalledOnce();
    modalButton(page, "Close")!.click();
    await page.updateComplete;
    await clickCandidate(page, "anthropic-api-key");

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        [
          "openclaw.setup.activate.start",
          {
            sessionId: expect.any(String),
            agentId: "main",
            kind: "saved-auth:expired",
            modelRef: "openai/existing",
          },
        ],
        [
          "openclaw.setup.activate.start",
          {
            sessionId: expect.any(String),
            agentId: "main",
            kind: "anthropic-api-key",
            modelRef: "anthropic/replacement",
          },
        ],
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
  });

  it.each(["transport", "unavailable"])(
    "keeps the selected model through verification recovery: %s",
    async (failure) => {
      await interruptedActivation();
      const { context, client, request } = createFirstRunContext();
      const error = "Gateway settings are saved but not active yet. Retry after the restart.";
      if (failure === "transport") {
        request.mockRejectedValue(new Error(error));
      } else {
        request.mockResolvedValue({ ok: false, status: "unavailable", error });
      }

      const { page } = await mountDetection(context, client, {
        configuredModel: "openai/relaunch",
        setupComplete: true,
        candidates: [candidate("anthropic-api-key", "anthropic/replacement", true)],
      });

      await waitForFast(() => {
        expect(page.querySelector(".model-setup__failure")?.textContent).toContain(error);
      });
      expect(page.textContent).not.toContain("Continue setup");
      expect(request).toHaveBeenCalledOnce();
      expect(context.navigate).not.toHaveBeenCalled();
      const retry = pageButton(page, ".model-setup__recovery .btn.primary")!;
      expect(retry.disabled).toBe(false);
      request.mockResolvedValueOnce({ ok: true, modelRef: "openai/relaunch", latencyMs: 31 });
      retry.click();
      await waitForOnboarding(context);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.verify",
        "openclaw.setup.verify",
      ]);
    },
  );

  it("keeps a successfully committed first-run setup visible when config refresh fails", async () => {
    const { context, client, request } = createFirstRunContext(
      "config.get failed after model commit",
    );
    request.mockResolvedValue(activated("openai/new"));

    const { page } = await mountDetection(context, client, {
      candidates: [candidate("openai-api-key", "openai/new", true)],
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(page.textContent).toContain("Model verified");
      expect(page.textContent).toContain("config.get failed after model commit");
    });
    expect(context.navigate).not.toHaveBeenCalled();
    clearFirstRunActivationReceipt();
    await page.updateComplete;
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(page.textContent).not.toContain("Model verified");
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it.each(["late activation reply", "different configured model"] as const)(
    "reconciles an activation across reconnect: %s",
    async (outcome) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      const late = outcome === "late activation reply";
      const expected = late ? "openai/new" : "openai/expected";
      const configuredModel = late ? expected : "openai/different";
      const activation = createDeferred<WizardNextResult>();
      mockRequests(request, {
        "openclaw.setup.activate.start": () =>
          late ? activation.promise : activated(expected, { gatewayRestartRequired: true }),
        "openclaw.setup.detect": () => ({ ...detection, configuredModel, setupComplete: true }),
        "openclaw.setup.verify": () => ({ ok: true, modelRef: configuredModel, latencyMs: 31 }),
      });
      const { page } = await mountDetection(context, client, {
        candidates: [candidate("openai-api-key", expected, true)],
      });
      expect(request).not.toHaveBeenCalled();
      await clickCandidate(page, "openai-api-key");
      if (late) {
        await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      } else {
        await waitForText(page, "The Gateway is restarting");
      }
      await reconnectGateway(page, snapshot, publishGatewaySnapshot);
      if (late) {
        await waitForFast(() => {
          expect(
            request.mock.calls
              .map(([method]) => method)
              .filter((method) => method.startsWith("openclaw.setup.")),
          ).toEqual([
            "openclaw.setup.activate.start",
            "openclaw.setup.detect",
            "openclaw.setup.verify",
          ]);
          expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
        });
        expect(context.navigate).not.toHaveBeenCalledWith("chat");
        activation.resolve(activated(expected, { gatewayRestartRequired: true }));
      } else {
        await waitForFast(() => {
          expect(page.textContent).toContain("Couldn’t use the model");
          expect(page.textContent).toContain(expected);
        });
        expect(context.navigate).not.toHaveBeenCalled();
      }
    },
  );

  it("does not continue a stale first-run activation after leaving the onboarding route", async () => {
    const warnings = vi.spyOn(console, "warn");
    const { context, client, request } = createFirstRunContext();
    const activation = createDeferred<WizardNextResult>();
    mockRequests(request, {
      "openclaw.setup.detect": () => detection,
      "openclaw.setup.activate.start": () => activation.promise,
    });

    const { page } = await mountDetection(context, client, {
      candidates: [
        candidate("openai-api-key", "openai/first", true),
        candidate("anthropic-api-key", "anthropic/second", true),
      ],
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    page.routeData = { firstRun: false };
    await page.updateComplete;
    activation.resolve({ done: true, status: "error", error: "The first login expired" });

    await waitForFast(() => expect(request.mock.settledResults[0]?.type).toBe("fulfilled"));
    await page.updateComplete;
    expect(page.textContent).not.toContain("The first login expired");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.activate.start",
      "wizard.cancel",
      "openclaw.setup.detect",
      "openclaw.setup.detect",
    ]);
    expect(context.navigate).not.toHaveBeenCalled();
    expect(warnings.mock.calls.flat().join("\n")).not.toContain("[STRICT_READ_UNTRACKED]");
  });

  it("redetects before activating when a first-run visit replaces ordinary settings", async () => {
    const warnings = vi.spyOn(console, "warn");
    const { context, client, request } = createFirstRunContext();
    mockRequests(request, {
      "openclaw.setup.detect": () => ({
        ...detection,
        candidates: [candidate("anthropic-api-key", "anthropic/fresh", true)],
      }),
      "openclaw.setup.activate.start": (params) => {
        const parameters = requestParameters(params);
        if (!("modelRef" in parameters)) {
          throw new Error("Model activation is missing its model reference.");
        }
        return { done: true, status: "done", modelActivation: { modelRef: parameters.modelRef } };
      },
    });
    const { page } = await mountDetection(
      context,
      client,
      { candidates: [candidate("openai-api-key", "openai/stale", true)] },
      false,
    );

    page.routeData = { firstRun: true };
    await page.updateComplete;
    await waitForText(page, "anthropic/fresh");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.detect"]);
    await clickCandidate(page, "anthropic-api-key");

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.detect", { agentId: "main" }],
        [
          "openclaw.setup.activate.start",
          {
            sessionId: expect.any(String),
            agentId: "main",
            kind: "anthropic-api-key",
            modelRef: "anthropic/fresh",
          },
        ],
      ]);
    });
    await waitForOnboarding(context);
    expect(warnings.mock.calls.flat().join("\n")).not.toContain("[STRICT_READ_UNTRACKED]");
  });
});

async function interruptedActivation() {
  const original = createFirstRunContext();
  original.request.mockResolvedValue(
    activated("openai/relaunch", { gatewayRestartRequired: true }),
  );
  const { page, provider } = await mountDetection(original.context, original.client, {
    candidates: [candidate("openai-api-key", "openai/relaunch", true)],
  });
  expect(original.request).not.toHaveBeenCalled();
  await clickCandidate(page, "openai-api-key");
  await waitForText(page, "The Gateway is restarting");
  unmountModelSetupPage(page);
  provider.remove();

  return original;
}

describe("ModelSetupPage first-run application recovery", () => {
  useFirstRunFixtures("durable-device-private-key-for-testing", true);
  it("reconciles a missing restored wizard after detection recovers", async () => {
    const original = createFirstRunContext();
    const result = {
      ...detection,
      authOptions: [authOption("custom-api-key", "Custom provider", "custom")],
    };
    const question = runningStep({ id: "provider-url", type: "text", message: "API Base URL" });
    let sessionId: string | undefined;
    mockRequests(original.request, {
      "openclaw.setup.auth.start": (params) => {
        sessionId = (params as { sessionId: string }).sessionId;
        return { sessionId, done: false, status: "running" };
      },
      "wizard.next": () => question,
    });
    const { page: previous, provider } = await mountDetection(
      original.context,
      original.client,
      result,
    );
    previous.discoveryOpen = true;
    await previous.updateComplete;
    authButton(previous, "custom-api-key")!.click();
    await waitForText(previous, "API Base URL");
    unmountModelSetupPage(previous);
    provider.remove();

    const relaunched = createFirstRunContext();
    let failDetection = true;
    mockRequests(relaunched.request, {
      "wizard.next": () => {
        throw missingWizardError();
      },
      "openclaw.setup.detect": () => {
        if (failDetection) {
          throw new Error("Setup detection is unavailable");
        }
        return result;
      },
    });
    const { page } = await mountDetection(relaunched.context, relaunched.client, result);
    page.discoveryOpen = true;
    await page.updateComplete;
    await waitForFast(() =>
      expect(relaunched.request).toHaveBeenCalledWith(
        "wizard.next",
        { sessionId },
        { timeoutMs: null, signal: expect.any(AbortSignal) },
      ),
    );
    await waitForText(page, "This setup may have finished");
    await waitForFast(() => {
      expect(readFirstRunActivationReceipt(relaunched.context)).not.toBeNull();
    });
    if (failDetection) {
      const close = modalButton(page, "Close")!;
      close.click();
      await page.updateComplete;
      await waitForText(page, "Setup detection is unavailable");
      expect(authButton(page, "custom-api-key")!.disabled).toBe(true);
      failDetection = false;
      const retry = [
        ...page.querySelectorAll<HTMLButtonElement>(".model-setup__recovery button"),
      ].find((button) => button.textContent?.trim() === "Check again")!;
      retry.click();
      await waitForFast(() => {
        expect(readFirstRunActivationReceipt(relaunched.context)).toBeNull();
        expect(authButton(page, "custom-api-key")!.disabled).toBe(false);
      });
    }
    expect(
      relaunched.request.mock.calls.some(([method]) => method === "openclaw.setup.auth.start"),
    ).toBe(false);
    expect(
      relaunched.request.mock.calls
        .filter(([method]) => method === "wizard.next")
        .map(([, params]) => params),
    ).toEqual([{ sessionId }]);
    expect(relaunched.context.navigate).not.toHaveBeenCalled();
  });

  it("rejects restored verification after its receipt expires", async () => {
    const original = await interruptedActivation();

    const relaunched = createFirstRunContext();
    const verification = createDeferred<unknown>();
    relaunched.request.mockReturnValue(verification.promise);
    const { page: restored } = await mountDetection(relaunched.context, relaunched.client, {
      configuredModel: "openai/relaunch",
      setupComplete: true,
    });

    await waitForFast(() => expect(relaunched.request).toHaveBeenCalledOnce());
    const receipt = readFirstRunActivationReceipt(relaunched.context)!;
    vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineMs + 1);
    verification.resolve({ ok: true, modelRef: "openai/relaunch", latencyMs: 31 });
    await waitForFast(() => expect(relaunched.request).toHaveResolved());
    await restored.updateComplete;
    expect(relaunched.context.navigate).not.toHaveBeenCalled();
    expect(restored.querySelector(".model-setup__verified")).toBeNull();
    expect(restored.textContent).not.toContain("Continue setup");
    expect(restored.textContent).not.toContain("Cannot read properties");
    expect(original.request).toHaveBeenCalledOnce();
    expect(relaunched.request).toHaveBeenCalledOnce();
    expect(relaunched.request).toHaveBeenCalledWith(
      "openclaw.setup.verify",
      { agentId: "main" },
      { timeoutMs: MODEL_SETUP_VERIFY_TIMEOUT_MS, signal: expect.any(AbortSignal) },
    );
  });

  it("never repeats an ambiguous activation after app recreation until explicitly retried", async () => {
    const original = await interruptedActivation();

    const relaunched = createFirstRunContext();
    mockRequests(relaunched.request, {
      "openclaw.setup.detect": () => ({
        ...detection,
        candidates: [candidate("openai-api-key", "openai/relaunch", true)],
      }),
      "openclaw.setup.activate.start": () => activated("openai/relaunch"),
    });
    const { page } = await mountDetection(relaunched.context, relaunched.client, {
      candidates: [candidate("openai-api-key", "openai/relaunch", true)],
    });
    page.discoveryOpen = true;
    await page.updateComplete;

    await waitForFast(() => {
      expect(page.textContent).toContain("previous activation is unresolved");
      expect(page.textContent).toContain("Check again");
      expect(pageButton(page, '[data-candidate-kind="openai-api-key"] button')?.disabled).toBe(
        true,
      );
    });
    pageButton(page, '[data-candidate-kind="openai-api-key"] button')!.click();
    expect(relaunched.request).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500_000);
    [...page.querySelectorAll<HTMLButtonElement>(".model-setup__recovery button")]
      .find((button) => button.textContent?.trim() === "Check again")!
      .click();
    await waitForModelSetupDetection(page);
    expect(relaunched.request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.detect",
    ]);
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(relaunched.request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.detect",
        "openclaw.setup.activate.start",
      ]);
      expect(relaunched.context.navigate).toHaveBeenCalledWith("custodian", {
        search: "?onboarding=1",
      });
    });
    expect(original.request).toHaveBeenCalledOnce();
  });

  it("does not repeat an unconfirmed activation after reconnect without an explicit retry", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    let resolveFirstActivation: ((result: WizardNextResult) => void) | undefined;
    let activationCount = 0;
    mockRequests(request, {
      "openclaw.setup.activate.start": async () => {
        activationCount += 1;
        if (activationCount === 1) {
          return await new Promise<WizardNextResult>((resolve) => {
            resolveFirstActivation = resolve;
          });
        }
        return activated("openai/new");
      },
      "openclaw.setup.detect": () => ({
        ...detection,
        candidates: [candidate("openai-api-key", "openai/new", true)],
      }),
    });

    const { page } = await mountDetection(context, client, {
      candidates: [candidate("openai-api-key", "openai/new", true)],
    });
    page.discoveryOpen = true;
    await page.updateComplete;
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(resolveFirstActivation).toBeTypeOf("function"));

    await reconnectGateway(page, snapshot, publishGatewaySnapshot);

    await waitForFast(() => {
      expect(page.textContent).toContain("previous activation is unresolved");
      expect(page.textContent).toContain("Check again");
    });
    expect(activationCount).toBe(1);
    expect(context.navigate).not.toHaveBeenCalled();

    await waitForElement(page, ".model-setup__recovery .btn");
    await waitForModelSetupDetection(page);
    const retry = pageButton(page, ".model-setup__recovery .btn")!;
    expect(retry.disabled).toBe(false);
    expect(JSON.parse(pendingReceipt()!).deadlineMs).toBeGreaterThan(Date.now());
    retry.click();
    await page.updateComplete;
    expect(activationCount).toBe(1);
    await waitForText(page, "may still be running");
    await waitForModelSetupDetection(page);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500_000);
    retry.click();
    await waitForModelSetupDetection(page);
    expect(activationCount).toBe(1);
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(activationCount).toBe(2);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
    resolveFirstActivation?.(activated("openai/new", { gatewayRestartRequired: true }));
  });
});
