/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { WizardNextResult } from "../../api/types.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { clearFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import {
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
} from "./model-setup-first-run.test-support.ts";

describe("ModelSetupPage first-run inference", () => {
  useFirstRunFixtures("durable-device-private-key-for-testing", true);
  it.each(["current", "reconnect"])(
    "finishes native Use only while its page is current (%s)",
    async (owner) => {
      const entered = createDeferred();
      const release = createDeferred();
      const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext(
        undefined,
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      const agents = createAgentCapability(context.gateway);
      Object.assign(context, { agents });
      const refresh = vi.spyOn(agents, "refreshList");
      mockRequests(request, {
        "models.list": () => ({
          models: [
            {
              provider: "acp-opencode",
              id: "fixture-model",
              name: "Fixture model",
              available: true,
              agentRuntime: { id: "acp-opencode", source: "implicit" },
            },
          ],
        }),
        "openclaw.setup.detect": () => detection,
        "agents.update": () => ({ ok: true, agentId: "main" }),
        "agents.list": () => ({
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", model: "acp-opencode/fixture-model" }],
        }),
      });
      const { page } = await mountDetection(context, client, detection);
      try {
        pageButton(page, "[data-native-model-setup] .picker-select__trigger")!.click();
        const option = '[role="option"][data-value="acp-opencode/fixture-model"]';
        await waitForElement(page, option);
        page.querySelector<HTMLElement>(option)!.click();
        await page.updateComplete;
        pageButton(page, "[data-native-model-setup] button.primary")!.click();
        await entered.promise;
        expect(request).toHaveBeenCalledWith("agents.update", {
          agentId: "main",
          model: "acp-opencode/fixture-model",
          agentRuntime: "acp-opencode",
        });
        expect(
          request.mock.calls.some(
            ([method]) =>
              method === "openclaw.setup.verify" || method === "openclaw.setup.activate.start",
          ),
        ).toBe(false);
        if (owner === "reconnect") {
          publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
          publishGatewaySnapshot({ ...snapshot, hello: { ...snapshot.hello } });
          await page.updateComplete;
        }
        release.resolve();
        await vi.mocked(context.runtimeConfig.runExternalMutation).mock.results[0]!.value;
        if (owner === "current") {
          await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("chat"));
          expect(refresh).toHaveBeenCalledOnce();
          expect(agents.state.agentsList?.agents[0]?.model).toBe("acp-opencode/fixture-model");
        } else {
          await Promise.resolve();
          expect(refresh).not.toHaveBeenCalled();
          expect(context.navigate).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        agents.dispose();
      }
    },
  );

  it("only permits candidate retry after a proven rejection", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockResolvedValue({
      done: true,
      status: "error",
      error: "The model could not finish setup",
      activationRejection: { disposition: "rejected-before-promotion", status: "auth" },
    });
    const { page } = await mountDetection(context, client, {
      candidates: [
        candidate("claude-cli", "provider/signed-out", false),
        candidate("openai-api-key", "provider/expired", true),
        candidate("provider-auto:local", "provider/other"),
      ],
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForText(page, "The model could not finish setup");
    expect(request).toHaveBeenCalledOnce();
    expect(context.navigate).not.toHaveBeenCalled();
    const retry = pageButton(page, '[data-candidate-kind="openai-api-key"] button')!;
    expect(retry.disabled).toBe(false);
    expect(pendingReceipt()).toBeNull();
    modalButton(page, "Close")!.click();
    await page.updateComplete;
    expect(page.querySelector(".model-setup__recovery")).toBeNull();
    retry.click();
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not offer verification when the Gateway does not advertise it", async () => {
    const { context, client, request, snapshot } = createFirstRunContext();
    snapshot.hello.features.methods = snapshot.hello.features.methods.filter(
      (method) => method !== "openclaw.setup.verify",
    );

    const { page } = await mountDetection(context, client, {
      configuredModel: "openai/existing",
      setupComplete: true,
    });

    expect(page.querySelector(".model-setup__current button")).toBeNull();
    expect(page.textContent).not.toContain("Continue setup");
    expect(request).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("repairs definitively failed existing setup with a different credentialed candidate", async () => {
    const { context, client, request } = createFirstRunContext();
    mockRequests(request, {
      "openclaw.setup.verify": () => ({
        ok: false,
        status: "auth",
        error: "The saved login expired",
      }),
      "openclaw.setup.activate.start": () => activated("anthropic/replacement"),
    });

    const { page } = await mountDetection(context, client, {
      configuredModel: "openai/existing",
      setupComplete: true,
      candidates: [
        candidate("existing-model", "openai/existing", true),
        candidate("openai-api-key", "openai/existing", true),
        candidate("anthropic-api-key", "anthropic/replacement", true),
      ],
    });

    expect(request).not.toHaveBeenCalled();
    pageButton(page, ".model-setup__current button")!.click();
    await waitForText(page, "The saved login expired");
    expect(request).toHaveBeenCalledOnce();
    await clickCandidate(page, "anthropic-api-key");

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.verify", { agentId: "main" }],
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
      const { context, client, request } = createFirstRunContext();
      const error = "Gateway settings are saved but not active yet. Retry after the restart.";
      if (failure === "transport") {
        request.mockRejectedValue(new Error(error));
      } else {
        request.mockResolvedValue({ ok: false, status: "unavailable", error });
      }

      const { page } = await mountDetection(context, client, {
        configuredModel: "openai/existing",
        setupComplete: true,
        candidates: [candidate("anthropic-api-key", "anthropic/replacement", true)],
      });

      expect(request).not.toHaveBeenCalled();
      pageButton(page, ".model-setup__current button")!.click();
      await waitForFast(() => {
        expect(page.textContent).toContain(error);
      });
      expect(page.textContent).not.toContain("Continue setup");
      expect(request).toHaveBeenCalledOnce();
      expect(context.navigate).not.toHaveBeenCalled();
      const retry = pageButton(page, ".model-setup__current button")!;
      expect(retry.disabled).toBe(false);
      request.mockResolvedValueOnce({ ok: true, modelRef: "openai/existing", latencyMs: 31 });
      retry.click();
      await waitForElement(page, ".model-setup__verified");
      const continueSetup = [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Continue setup"),
      )!;
      continueSetup.click();
      expect(context.navigate).toHaveBeenCalledWith("chat");
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
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("config.get failed after model commit");
    });
    expect(context.navigate).not.toHaveBeenCalled();
    clearFirstRunActivationReceipt();
    await page.updateComplete;
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(page.textContent).not.toContain("Connection verified");
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
          expect(page.textContent).toContain("The model could not be activated");
          expect(page.textContent).toContain(expected);
        });
        expect(context.navigate).not.toHaveBeenCalled();
      }
    },
  );

  it("does not continue a stale first-run activation after leaving the onboarding route", async () => {
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
  });

  it("redetects before activating when a first-run visit replaces ordinary settings", async () => {
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
    await waitForFast(() =>
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
    );
  });
});
