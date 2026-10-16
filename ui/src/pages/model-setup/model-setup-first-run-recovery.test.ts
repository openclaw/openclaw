/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { readFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import {
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountPage,
  waitForModelSetupDetection,
} from "./model-setup-first-run.test-support.ts";
import { MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";
import { unmountModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

describe("ModelSetupPage first-run application recovery", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "durable-device-private-key-for-testing" }),
    );
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reconciles a missing restored wizard after detection recovers", async () => {
    const original = createFirstRunContext();
    const result = {
      ...detection,
      authOptions: [
        {
          id: "custom-api-key",
          label: "Custom provider",
          kind: "custom" as const,
          featured: true,
        },
      ],
    };
    const question = {
      done: false,
      status: "running",
      step: { id: "provider-url", type: "text", message: "API Base URL" },
    };
    let sessionId: string | undefined;
    original.request.mockImplementation(async (method, params) => {
      if (method === "openclaw.setup.auth.start") {
        sessionId = (params as { sessionId: string }).sessionId;
        return { sessionId, done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return question;
      }
      throw new Error("Original connection closed");
    });
    const { page: previous, provider } = await mountPage(original.context, {
      state: { phase: "ready", result },
      client: original.client,
      firstRun: true,
    });
    previous
      .querySelector<HTMLButtonElement>('[data-auth-choice="custom-api-key"] button')!
      .click();
    await waitForFast(() => expect(previous.textContent).toContain("API Base URL"));
    unmountModelSetupPage(previous);
    provider.remove();

    const relaunched = createFirstRunContext();
    let failDetection = true;
    relaunched.request.mockImplementation(async (method) => {
      if (method === "wizard.next") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "wizard not found",
          details: { code: "WIZARD_NOT_FOUND" },
        });
      }
      if (method === "openclaw.setup.detect") {
        if (failDetection) {
          throw new Error("Setup detection is unavailable");
        }
        return result;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(relaunched.context, {
      state: { phase: "ready", result },
      client: relaunched.client,
      firstRun: true,
    });
    await waitForFast(() =>
      expect(relaunched.request).toHaveBeenCalledWith(
        "wizard.next",
        { sessionId },
        { timeoutMs: null, signal: expect.any(AbortSignal) },
      ),
    );
    await waitForFast(() =>
      expect(page.textContent).toContain("Gateway no longer has this setup session"),
    );
    await waitForFast(() => {
      expect(
        page.querySelector<HTMLButtonElement>('[data-auth-choice="custom-api-key"] button')!
          .disabled,
      ).toBe(true);
      expect(readFirstRunActivationReceipt(relaunched.context)).not.toBeNull();
    });
    if (failDetection) {
      await waitForFast(() => expect(page.textContent).toContain("Setup detection is unavailable"));
      const close = [
        ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
      ].find((button) => button.textContent?.trim() === "Close")!;
      close.click();
      failDetection = false;
      const retry = [
        ...page.querySelectorAll<HTMLButtonElement>(".model-setup__recovery button"),
      ].find((button) => button.textContent?.trim() === "Check again")!;
      retry.click();
      await waitForFast(() => {
        expect(readFirstRunActivationReceipt(relaunched.context)).toBeNull();
        expect(
          page.querySelector<HTMLButtonElement>('[data-auth-choice="custom-api-key"] button')!
            .disabled,
        ).toBe(false);
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
    const original = createFirstRunContext();
    original.request.mockResolvedValue({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/relaunch", gatewayRestartRequired: true },
    });
    const { page, provider } = await mountPage(original.context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/relaunch", true)],
        },
      },
      client: original.client,
      firstRun: true,
    });
    expect(original.request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(page.textContent).toContain("The Gateway is restarting"));
    unmountModelSetupPage(page);
    provider.remove();

    const relaunched = createFirstRunContext();
    const verification = createDeferred<unknown>();
    relaunched.request.mockReturnValue(verification.promise);
    const { page: restored } = await mountPage(relaunched.context, {
      state: {
        phase: "ready",
        result: { ...detection, configuredModel: "openai/relaunch", setupComplete: true },
      },
      client: relaunched.client,
      firstRun: true,
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
    const original = createFirstRunContext();
    original.request.mockResolvedValue({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/relaunch", gatewayRestartRequired: true },
    });
    const { page: previous, provider } = await mountPage(original.context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/relaunch", true)],
        },
      },
      client: original.client,
      firstRun: true,
    });
    expect(original.request).not.toHaveBeenCalled();
    await clickCandidate(previous, "openai-api-key");
    await waitForFast(() => expect(previous.textContent).toContain("The Gateway is restarting"));
    unmountModelSetupPage(previous);
    provider.remove();

    const relaunched = createFirstRunContext();
    relaunched.request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/relaunch", true)],
        };
      }
      if (method === "openclaw.setup.activate.start") {
        return { done: true, status: "done", modelActivation: { modelRef: "openai/relaunch" } };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(relaunched.context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/relaunch", true)],
        },
      },
      client: relaunched.client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("previous activation is unresolved");
      expect(page.textContent).toContain("Check again");
      expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);
    });
    page.querySelector<HTMLButtonElement>("[data-models-connect]")?.click();
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
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate.start") {
        activationCount += 1;
        if (activationCount === 1) {
          return await new Promise<WizardNextResult>((resolve) => {
            resolveFirstActivation = resolve;
          });
        }
        return { done: true, status: "done", modelActivation: { modelRef: "openai/new" } };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(resolveFirstActivation).toBeTypeOf("function"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("previous activation is unresolved");
      expect(page.textContent).toContain("Check again");
    });
    expect(activationCount).toBe(1);
    expect(context.navigate).not.toHaveBeenCalled();

    await waitForFast(() =>
      expect(page.querySelector(".model-setup__recovery .btn")).not.toBeNull(),
    );
    await waitForModelSetupDetection(page);
    const retry = page.querySelector<HTMLButtonElement>(".model-setup__recovery .btn")!;
    expect(retry.disabled).toBe(false);
    expect(
      JSON.parse(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")!).deadlineMs,
    ).toBeGreaterThan(Date.now());
    retry.click();
    await page.updateComplete;
    expect(activationCount).toBe(1);
    await waitForFast(() => expect(page.textContent).toContain("may still be running"));
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
    resolveFirstActivation?.({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/new", gatewayRestartRequired: true },
    });
  });
});
