/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";
import {
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountPage,
  selectManualProvider,
} from "./model-setup-first-run.test-support.ts";

const utility = {
  ...candidate("provider-auto:local", "local/setup", true),
  modelTarget: "utility" as const,
};

describe("ModelSetupPage utility roles", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "synthetic-utility-device-key" }),
    );
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "opens the setup assistant after explicit utility activation (first run: %s)",
    async (firstRun) => {
      const { context, client, request } = createFirstRunContext();
      request.mockResolvedValue({
        done: true,
        status: "done",
        modelActivation: { modelRef: utility.modelRef, modelTarget: "utility" },
      });
      const { page } = await mountPage(context, {
        state: { phase: "ready", result: { ...detection, candidates: [utility] } },
        client,
        firstRun,
      });

      expect(page.textContent).toContain("Setup & utility");
      expect(page.textContent).toContain("Use for setup");
      expect(request).not.toHaveBeenCalled();
      await clickCandidate(page, utility.kind);
      if (!firstRun) {
        await waitForFast(() => expect(page.textContent).toContain("Setup & utility model ready"));
        const success = page.querySelector(".model-setup-success")!;
        expect(success.textContent).not.toContain("start chatting");
        expect(success.textContent).not.toContain("Active model");
        [...success.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Open setup assistant"))!
          .click();
      }

      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      expect(request.mock.calls[0]?.[1]).toMatchObject({
        kind: utility.kind,
        modelRef: utility.modelRef,
        modelTarget: "utility",
      });
      expect(context.navigate).not.toHaveBeenCalledWith("chat");
    },
  );

  it.each([false, true])(
    "keeps the configured utility available for reopening and repair (primary: %s)",
    async (primary) => {
      const { context, client, request } = createFirstRunContext();
      request.mockResolvedValue({
        done: true,
        status: "done",
        modelActivation: { modelRef: utility.modelRef, modelTarget: "utility" },
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [utility],
            utilityModel: utility.modelRef,
            ...(primary
              ? { configuredModel: "cloud/primary", setupComplete: true }
              : { setupModel: utility.modelRef }),
          },
        },
        client,
        firstRun: true,
      });

      expect(page.querySelector(".model-setup__current") !== null).toBe(primary);
      expect(page.querySelector(`[data-candidate-kind="${utility.kind}"]`)).toBeNull();
      expect(page.textContent).toContain(
        primary
          ? "Regular chats use your primary model"
          : "Choose a primary model below for regular chats",
      );
      const buttons = [...page.querySelectorAll<HTMLButtonElement>(".model-setup__utility button")];
      buttons.find((button) => button.textContent?.includes("Open setup assistant"))!.click();
      expect(context.navigate).toHaveBeenCalledWith(
        "custodian",
        primary ? {} : { search: "?onboarding=1" },
      );
      expect(request).not.toHaveBeenCalled();
      buttons.find((button) => button.textContent?.includes("Recheck & repair"))!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "openclaw.setup.activate.start",
          expect.objectContaining({
            kind: utility.kind,
            modelRef: utility.modelRef,
            modelTarget: "utility",
          }),
          expect.anything(),
        ),
      );
    },
  );

  it("acknowledges a manual provider's utility role in the actual activation request", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockResolvedValue({
      done: true,
      status: "done",
      modelActivation: { modelRef: utility.modelRef, modelTarget: "utility" },
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          manualProviders: [
            { id: "manual-utility", label: "Utility API key", modelTarget: "utility" },
          ],
        },
      },
      client,
      firstRun: true,
    });
    await selectManualProvider(page, "manual-utility");
    const key = page.querySelector<HTMLInputElement>('input[type="password"]')!;
    key.value = "synthetic-utility-key";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.activate.start",
        expect.objectContaining({
          kind: "api-key",
          authChoice: "manual-utility",
          apiKey: "synthetic-utility-key",
          modelTarget: "utility",
        }),
        expect.anything(),
      ),
    );
    await waitForFast(() =>
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
    );
  });

  it.each(["oauth", "install"] as const)(
    "preserves utility acknowledgement and pending intent for %s setup",
    async (kind) => {
      const { context, client, request } = createFirstRunContext();
      vi.spyOn(window, "open").mockReturnValue(null);
      request.mockImplementation(async (method, params) => {
        if (method === "openclaw.setup.auth.start") {
          expect(params).toMatchObject({ authChoice: "utility-login", modelTarget: "utility" });
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          expect(readFirstRunActivationReceipt(context)).toMatchObject({
            kind: "provider-auth",
            modelTarget: "utility",
            modelRef: null,
          });
          return {
            done: true,
            status: "done",
            modelActivation: { modelRef: utility.modelRef, modelTarget: "utility" },
          };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            authOptions: [
              {
                id: "utility-login",
                label: "Utility account",
                kind,
                featured: true,
                modelTarget: "utility",
              },
            ],
          },
        },
        client,
        firstRun: true,
      });
      page.querySelector<HTMLButtonElement>('[data-auth-choice="utility-login"] button')!.click();
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.auth.start",
        "wizard.next",
      ]);
    },
  );

  it("retains the advertised utility role when preparation directly returns its model", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method, params) => {
      if (method === "openclaw.setup.prepare.start") {
        return { done: true, status: "done", preparedModelRef: utility.modelRef };
      }
      if (method === "openclaw.setup.activate.start") {
        expect(params).toMatchObject({
          kind: utility.kind,
          modelRef: utility.modelRef,
          modelTarget: "utility",
        });
        return {
          done: true,
          status: "done",
          modelActivation: { modelRef: utility.modelRef, modelTarget: "utility" },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          prepareOptions: [
            {
              id: "local",
              label: "Utility model",
              modelTarget: "utility",
            },
          ],
        },
      },
      client,
      firstRun: true,
    });
    page.querySelector<HTMLButtonElement>('[data-prepare-choice="local"] button')!.click();
    await waitForFast(() =>
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.prepare.start",
      "openclaw.setup.activate.start",
    ]);
  });

  it.each([
    { primary: false, replyTarget: "utility" as const, expected: true },
    { primary: true, replyTarget: "utility" as const, expected: true },
    { primary: true, replyTarget: undefined, expected: false },
  ])(
    "recovers only the owned utility verification with primary=$primary and reply=$replyTarget",
    async ({ primary, replyTarget, expected }) => {
      const { context, client, request } = createFirstRunContext();
      persistFirstRunActivationReceipt(context, utility);
      request.mockResolvedValue({
        ok: true,
        modelRef: utility.modelRef,
        ...(replyTarget ? { modelTarget: replyTarget } : {}),
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [utility],
            utilityModel: utility.modelRef,
            ...(primary
              ? { configuredModel: "cloud/primary", setupComplete: true }
              : { setupModel: utility.modelRef }),
          },
        },
        client,
        firstRun: true,
      });
      await waitForFast(() => expect(request).toHaveResolved());
      await page.updateComplete;

      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.verify",
        { agentId: "main", modelTarget: "utility" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      if (expected) {
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
      } else {
        expect(context.navigate).not.toHaveBeenCalled();
        expect(page.querySelector(".model-setup__verified")).toBeNull();
      }
    },
  );
});
