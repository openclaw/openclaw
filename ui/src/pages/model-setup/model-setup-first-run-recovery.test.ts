/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { readFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import {
  waitForText,
  waitForElement,
  runningStep,
  authButton,
  pageButton,
  authOption,
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
  waitForModelSetupDetection,
} from "./model-setup-first-run.test-support.ts";
import { MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";
import { unmountModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

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
    authButton(previous, "custom-api-key")!.click();
    await waitForText(previous, "API Base URL");
    unmountModelSetupPage(previous);
    provider.remove();

    const relaunched = createFirstRunContext();
    let failDetection = true;
    mockRequests(relaunched.request, {
      "wizard.next": () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "wizard not found",
          details: { code: "WIZARD_NOT_FOUND" },
        });
      },
      "openclaw.setup.detect": () => {
        if (failDetection) {
          throw new Error("Setup detection is unavailable");
        }
        return result;
      },
    });
    const { page } = await mountDetection(relaunched.context, relaunched.client, result);
    await waitForFast(() =>
      expect(relaunched.request).toHaveBeenCalledWith(
        "wizard.next",
        { sessionId },
        { timeoutMs: null, signal: expect.any(AbortSignal) },
      ),
    );
    await waitForText(page, "Gateway no longer has this setup session");
    await waitForFast(() => {
      expect(authButton(page, "custom-api-key")!.disabled).toBe(true);
      expect(readFirstRunActivationReceipt(relaunched.context)).not.toBeNull();
    });
    if (failDetection) {
      await waitForText(page, "Setup detection is unavailable");
      const close = modalButton(page, "Close")!;
      close.click();
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

    await waitForFast(() => {
      expect(page.textContent).toContain("previous activation is unresolved");
      expect(page.textContent).toContain("Check again");
      expect(pageButton(page, "[data-models-connect]")?.disabled).toBe(true);
    });
    pageButton(page, "[data-models-connect]")?.click();
    expect(relaunched.request).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500_000);
    [...page.querySelectorAll<HTMLButtonElement>(".model-setup__intro .btn")]
      .find((button) => button.textContent?.trim() === "Check again")
      ?.click();
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
