/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { persistFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import {
  authButton,
  authOption,
  detection,
  selectManualProvider,
  setInput,
  waitForElement,
  missingWizardError,
  running,
  configuredDetection,
  waitForText,
  runningStep,
  answerWizard,
  enterManualKey,
  mockRequests,
  useFirstRunFixtures,
  pendingReceipt,
  modalButton,
  callsFor,
  candidate,
  clickCandidate,
  createFirstRunContext,
  mountDetection,
} from "./model-setup-first-run.test-support.ts";
import { createPage, mountModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

const knownChoices: SystemAgentSetupDetectResult = {
  ...detection,
  manualProviders: [{ id: "provider-key", label: "API provider" }],
  authOptions: [authOption("provider-login", "Provider login")],
};

// Known choices answer at once; the slow local scan finishes only when the test says so.
function mountDuringSlowDiscovery(
  handlers: Record<string, (params: unknown) => unknown> = {},
  beforeMount?: (context: ReturnType<typeof createFirstRunContext>["context"]) => void,
) {
  const fixture = createFirstRunContext();
  const discovery = createDeferred<SystemAgentSetupDetectResult>();
  fixture.setupOptions.mockResolvedValue(knownChoices);
  mockRequests(fixture.request, {
    "openclaw.setup.detect": () => discovery.promise,
    ...handlers,
  });
  beforeMount?.(fixture.context);
  const page = createPage(fixture.context);
  page.routeData = { firstRun: true };
  document.body.append(page);
  mountModelSetupPage(page);
  return { ...fixture, page, discovery };
}

const lateDiscovery = {
  ...knownChoices,
  candidates: [candidate("codex-cli", "openai/codex", true)],
};

describe("Model Setup known choices during discovery", () => {
  useFirstRunFixtures("test-device-key");

  it.each(["no receipt", "provider-login"] as const)(
    "keeps the person's provider, draft, and focus when discovery finishes (%s)",
    async (receipt) => {
      const { page, request, discovery } = mountDuringSlowDiscovery({}, (context) => {
        if (receipt === "provider-login") {
          persistFirstRunActivationReceipt(context, { kind: "provider-login" });
        }
      });
      await waitForFast(() => expect(authButton(page, "provider-login")?.disabled).toBe(false));
      await selectManualProvider(page, "provider-key");
      const input = page.querySelector<HTMLInputElement>(".model-setup__manual input")!;
      setInput(page, ".model-setup__manual input", "synthetic-draft");
      input.focus();
      expect(page.querySelector('[data-candidate-kind="codex-cli"]')).toBeNull();
      expect(
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.disabled,
      ).toBe(false);

      discovery.resolve(lateDiscovery);
      await waitForElement(page, '[data-candidate-kind="codex-cli"]');
      expect(page.querySelector(".model-setup__manual input")).toBe(input);
      expect(input.value).toBe("synthetic-draft");
      expect(document.activeElement).toBe(input);
      expect(page.querySelector(".model-setup-provider-select__trigger")?.textContent).toContain(
        "API provider",
      );
      expect(callsFor(request, "openclaw.setup.detect")).toHaveLength(1);
    },
  );

  it("keeps a browser sign-in started before discovery finishes", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { page, request, discovery } = mountDuringSlowDiscovery({
      "openclaw.setup.auth.start": () => running,
      "wizard.next": () =>
        runningStep({
          id: "browser",
          type: "text",
          message: "Finish sign-in in your browser",
          executor: "client",
        }),
    });
    await waitForFast(() => expect(authButton(page, "provider-login")?.disabled).toBe(false));
    authButton(page, "provider-login")!.click();
    await waitForText(page, "Finish sign-in in your browser");

    discovery.resolve(lateDiscovery);
    await waitForElement(page, '[data-candidate-kind="codex-cli"]');
    expect(page.textContent).toContain("Finish sign-in in your browser");
    expect(callsFor(request, "openclaw.setup.auth.start")).toHaveLength(1);
    expect(callsFor(request, "wizard.cancel")).toHaveLength(0);
  });

  it("waits for discovery while an earlier activation may still commit", async () => {
    const { page, discovery, setupOptions } = mountDuringSlowDiscovery({}, (context) =>
      persistFirstRunActivationReceipt(context, { kind: "provider-auth" }),
    );
    await waitForFast(() => expect(setupOptions).toHaveBeenCalledOnce());
    await page.updateComplete;
    expect(page.querySelector(".model-setup__loading")).not.toBeNull();
    expect(authButton(page, "provider-login")).toBeNull();
    discovery.resolve(knownChoices);
    await waitForElement(page, ".model-setup__recovery");
  });
});

describe("Model Setup explicit discovery", () => {
  useFirstRunFixtures("test-device-key");
  it.each(["cancel at credentials", "finish final commit"] as const)(
    "retains the admitted wizard after protected cancellation: %s",
    async (outcome) => {
      const { context, client, request } = createFirstRunContext();
      const installed = createDeferred();
      const allowInstall = createDeferred();
      const committed = createDeferred();
      const allowCommit = createDeferred();
      const terminal = createDeferred();
      const answers: unknown[] = [];
      let session: WizardSession | undefined;
      let sessionId: string | undefined;
      let starts = 0;
      mockRequests(request, {
        "openclaw.setup.activate.start": async (params) => {
          starts += 1;
          sessionId = (params as { sessionId: string }).sessionId;
          session = new WizardSession(async (prompter, _signal, owner) => {
            try {
              await prompter.confirm({ message: "Install provider?", initialValue: false });
              owner.lockCancellationForPreparation();
              installed.resolve();
              await allowInstall.promise;
              await prompter.text({ message: "Provider API key", sensitive: true });
              owner.finishPreparation();
              owner.lockCancellation();
              committed.resolve();
              await allowCommit.promise;
              owner.setModelActivation({ modelRef: "openai/selected" });
            } finally {
              terminal.resolve();
            }
          });
          return running;
        },
        "wizard.next": async (params) => {
          const next = params as WizardNextParams;
          expect(next.sessionId).toBe(sessionId);
          if (next.answer) {
            answers.push(next.answer.value);
            await session!.answer(next.answer.stepId, next.answer.value);
          }
          return await session!.next();
        },
        "wizard.cancel": (params) => {
          expect(params).toEqual({ sessionId });
          session!.cancel();
          return { status: session!.getStatus(), error: session!.getError() };
        },
        "openclaw.setup.detect": () => configuredDetection("openai/selected"),
        "openclaw.setup.verify": () => ({ ok: true, modelRef: "openai/selected", latencyMs: 12 }),
      });
      const { page } = await mountDetection(context, client, {
        candidates: [candidate("openai-api-key", "openai/selected", true)],
      });
      const cancel = () =>
        page.querySelector("openclaw-modal-dialog")!.dispatchEvent(new CustomEvent("modal-cancel"));
      try {
        await clickCandidate(page, "openai-api-key");
        await waitForText(page, "Install provider?");
        modalButton(page, "Yes")!.click();
        await installed.promise;
        cancel();
        await waitForText(page, "Setup is finishing the current step");
        expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
        expect(pendingReceipt()).not.toBeNull();
        expect(session!.getStatus()).toBe("running");
        expect(answers).toEqual([true]);
        expect(starts).toBe(1);
        allowInstall.resolve();
        await waitForText(page, "Provider API key");
        if (outcome === "cancel at credentials") {
          cancel();
          await terminal.promise;
          await waitForFast(() => expect(pendingReceipt()).toBeNull());
          expect(session!.getStatus()).toBe("cancelled");
          expect(answers).toEqual([true]);
        } else {
          await answerWizard(page, "synthetic-key", 'openclaw-modal-dialog input[type="password"]');
          await committed.promise;
          cancel();
          await waitForText(page, "Setup is finishing the current step");
          expect(session!.getStatus()).toBe("running");
          allowCommit.resolve();
          await terminal.promise;
          await waitForText(page, "Model verified");
          expect(answers).toEqual([true, "synthetic-key"]);
        }
        expect(starts).toBe(1);
      } finally {
        allowInstall.resolve();
        allowCommit.resolve();
        session?.close(new Error("test cleanup"));
        if (session) {
          await terminal.promise;
        }
      }
    },
  );

  it.each(["denied", "missing wizard"] as const)(
    "shows an explicit cancellation %s failure without discarding the clicked receipt",
    async (failure) => {
      const { context, client, request } = createFirstRunContext();
      let cancels = 0;
      const error =
        failure === "missing wizard"
          ? missingWizardError()
          : new GatewayRequestError({ code: "FORBIDDEN", message: "Cancel permission denied" });
      mockRequests(request, {
        "openclaw.setup.activate.start": () => running,
        "wizard.next": () =>
          runningStep({
            id: "credential",
            type: "text",
            message: "Provider credential",
            sensitive: true,
            executor: "client",
          }),
        "wizard.cancel": () => {
          if (++cancels === 1) {
            throw error;
          }
          return { status: "cancelled" };
        },
      });
      const { page } = await mountDetection(context, client, {
        candidates: [candidate("openai-api-key", "openai/selected", true)],
      });
      await clickCandidate(page, "openai-api-key");
      await waitForText(page, "Provider credential");
      const receipt = pendingReceipt();
      expect(receipt).not.toBeNull();
      const cancel = () =>
        page.querySelector("openclaw-modal-dialog")!.dispatchEvent(new CustomEvent("modal-cancel"));
      cancel();
      if (failure === "missing wizard") {
        await waitForText(page, "This setup may have finished");
        expect(cancels).toBe(1);
        expect(pendingReceipt()).toBe(receipt);
        expect(modalButton(page, "Close")).toBeDefined();
        modalButton(page, "Close")!.click();
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(page.querySelector(".model-setup__recovery")).not.toBeNull();
        expect(pendingReceipt()).toBe(receipt);
      } else {
        await waitForFast(() =>
          expect(page.querySelector(".model-setup-wizard .callout.warn")?.textContent).toContain(
            "Couldn’t confirm cancellation",
          ),
        );
        expect(page.textContent).toContain(error.message);
        expect(page.textContent).toContain("Provider credential");
        expect(pendingReceipt()).toBe(receipt);
        expect(cancels).toBe(1);
        cancel();
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(pendingReceipt()).toBeNull();
        expect(cancels).toBe(2);
      }
      expect(callsFor(request, "openclaw.setup.activate.start")).toHaveLength(1);
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );

  it("never offers native conversations or selects a manual provider implicitly", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockResolvedValue({ done: true, status: "cancelled" });
    // Even when the Gateway would record a fresh catalog preference, connecting AI
    // leaves that choice to Session sources and lets the Gateway keep it off.
    const { page } = await mountDetection(context, client, {
      configuredModel: "openai/existing",
      setupComplete: true,
      nativeSessionCatalogPreferenceRequired: true,
      nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
      manualProviders: [{ id: "provider-key", label: "API provider" }],
    });
    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".model-setup__native-discovery")).toBeNull();
    expect(page.querySelector("[data-selected]")).toBeNull();
    await enterManualKey(page, "provider-key", "test-only-key");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]![1]).not.toHaveProperty("nativeSessionCatalogsEnabled");
  });
});
