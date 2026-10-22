/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  missingWizardError,
  running,
  configuredDetection,
  waitForText,
  waitForElement,
  runningStep,
  answerWizard,
  enterManualKey,
  mockRequests,
  useFirstRunFixtures,
  pendingReceipt,
  modalButton,
  callsFor,
  setInput,
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountDetection,
  selectManualProvider,
} from "./model-setup-first-run.test-support.ts";

describe("Model Setup explicit discovery", () => {
  useFirstRunFixtures("test-device-key");
  const nativeInput = ".model-setup__native-discovery input";
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
          await waitForText(page, "Connection verified");
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
        await waitForText(page, "It may already have finished");
        expect(cancels).toBe(1);
        expect(pendingReceipt()).toBe(receipt);
        expect(modalButton(page, "Close")).toBeDefined();
        modalButton(page, "Close")!.click();
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(page.querySelector(".model-setup__recovery")).not.toBeNull();
        expect(pendingReceipt()).toBe(receipt);
      } else {
        await waitForFast(() =>
          expect(page.querySelector(".model-setup-wizard .callout.warning")?.textContent).toContain(
            "Could not confirm cancellation",
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

  it("does not change upgrade catalog choices or select a manual provider implicitly", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockResolvedValue({ done: true, status: "cancelled" });
    const { page } = await mountDetection(context, client, {
      configuredModel: "openai/existing",
      setupComplete: true,
      nativeSessionCatalogPreferenceRequired: false,
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
  it("clears a pending credential and native discovery opt-in when the Gateway identity changes", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    const fresh = {
      ...detection,
      nativeSessionCatalogPreferenceRequired: true,
      nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
      manualProviders: [{ id: "provider-key", label: "API provider" }],
    };
    request.mockResolvedValue(fresh);
    const { page } = await mountDetection(context, client, fresh);
    page.querySelector<HTMLInputElement>(nativeInput)!.click();
    await selectManualProvider(page, "provider-key");
    setInput(page, ".model-setup__manual input", "test-only-pending-key");
    await page.updateComplete;
    expect(request).not.toHaveBeenCalled();
    Object.assign(context.gateway, { connectionRevision: context.gateway.connectionRevision + 1 });
    publishGatewaySnapshot({ ...snapshot });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.detect",
        { agentId: "main" },
        expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) }),
      ),
    );
    await waitForElement(page, nativeInput);
    expect(page.querySelector(nativeInput)).toMatchObject({ checked: false });
    expect(page.querySelector(".model-setup__manual input")).toMatchObject({ value: "" });
    expect(page.querySelector("[data-selected]")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.detect"]);
  });
});
