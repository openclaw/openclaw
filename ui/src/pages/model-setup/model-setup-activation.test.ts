/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { persistFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import { FirstRunSetup } from "./first-run-setup.ts";
import {
  candidate,
  clickCandidate,
  selectManualProvider,
  createFirstRunContext,
  detection,
  mountPage,
  waitForModelSetupDetection,
} from "./model-setup-first-run.test-support.ts";
import { MODEL_SETUP_AUTH_START_TIMEOUT_MS } from "./state.ts";
import { unmountModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

describe("ModelSetupPage first-run activation ownership", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "test-device-key" }),
    );
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps first-run activation owned through an equivalent route-data refresh", async () => {
    const { context, client, request } = createFirstRunContext();
    const response = createDeferred<unknown>();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      if (method === "openclaw.setup.activate.start") {
        return response.promise;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "provider/verified", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    const success = {
      done: true,
      status: "done",
      modelActivation: { modelRef: "provider/verified" },
    };
    try {
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");
      page.routeData = { firstRun: true };
      await page.updateComplete;
      expect(request).toHaveBeenCalledOnce();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(receipt);
      response.resolve(success);
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      expect(request).toHaveBeenCalledOnce();
    } finally {
      response.resolve(success);
    }
  });

  it.each(["manual key", "provider sign-in"])(
    "requires an explicit current-model choice after losing a %s activation reply",
    async (entry) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      let releaseActivation: ((value: unknown) => void) | undefined;
      const activatedMethod =
        entry === "manual key" ? "openclaw.setup.activate.start" : "wizard.next";
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { sessionId: "auth", done: false, status: "running" };
        }
        if (method === activatedMethod) {
          if (entry === "provider sign-in" && releaseActivation) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "wizard not found",
              details: { code: "WIZARD_NOT_FOUND" },
            });
          }
          return await new Promise((resolve) => {
            releaseActivation = resolve;
          });
        }
        if (method === "openclaw.setup.detect") {
          return { ...detection, configuredModel: "provider/current", setupComplete: true };
        }
        if (method === "openclaw.setup.verify") {
          return { ok: true, modelRef: "provider/current", latencyMs: 31 };
        }
        if (method === "wizard.cancel") {
          // This request crossed the commit point: cancellation is unconfirmed,
          // and the late activation response below can still report success.
          return { status: "running" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            manualProviders: [{ id: "provider-key", label: "Provider key" }],
            authOptions: [
              { id: "provider-login", label: "Provider login", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      if (entry === "manual key") {
        await selectManualProvider(page, "provider-key");
        const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = "test-only-provider-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      } else {
        page
          .querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!
          .click();
      }
      await waitForFast(() => expect(releaseActivation).toBeTypeOf("function"));
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")!;
      expect(JSON.parse(receipt).modelRef).toBeNull();
      expect(receipt).not.toContain("test-only-provider-key");
      expect(JSON.parse(receipt).wizard?.authChoice).toBe(
        entry === "provider sign-in" ? "provider-login" : undefined,
      );
      publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
      await page.updateComplete;
      if (entry === "provider sign-in") {
        expect(page.textContent).toContain("Waiting for it to reconnect");
      }
      publishGatewaySnapshot({ ...snapshot, hello: { ...snapshot.hello } });
      if (entry === "provider sign-in") {
        // A restarted Gateway lost the wizard: recovery replaces the reconnect notice.
        await waitForFast(() =>
          expect(page.textContent).toContain("Gateway no longer has this setup session"),
        );
        expect(page.textContent).not.toContain("Waiting for it to reconnect");
        [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
          .find((button) => button.textContent?.trim() === "Close")!
          .click();
        await page.updateComplete;
      }
      await waitForFast(() => expect(page.textContent).toContain("Verify & use selected model"));
      await waitForModelSetupDetection(page);
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.verify"),
      ).toHaveLength(0);
      expect(context.navigate).not.toHaveBeenCalled();
      page.querySelector<HTMLButtonElement>(".model-setup__recovery .btn.primary")!.click();
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      releaseActivation?.({
        done: true,
        status: "done",
        modelActivation: { modelRef: "provider/late-other" },
      });
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === activatedMethod)).toHaveLength(
        entry === "provider sign-in" ? 2 : 1,
      );
      expect(request.mock.calls.filter(([method]) => method.endsWith(".start"))).toHaveLength(1);
      expect(context.navigate).toHaveBeenCalledOnce();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    },
  );

  it.each(["wrong-code start", "validation error"])(
    "retains unresolved auth after %s",
    async (outcome) => {
      const { context, client, request } = createFirstRunContext();
      const startMethod = "openclaw.setup.auth.start";
      const selector = '[data-auth-choice="provider-login"] button';
      const failure = "Provider could not finish this sign-in";
      request.mockImplementation(async (method) => {
        if (method === startMethod) {
          if (outcome === "wrong-code start") {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: failure,
              details: { code: "SETUP_ADMISSION_BUSY" },
              retryable: true,
            });
          }
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            error: failure,
            step: { id: "login", type: "text" },
          };
        }
        if (method === "wizard.cancel") {
          if (outcome === "validation error") {
            return { status: "running" };
          }
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "wizard not found",
            details: { code: "WIZARD_NOT_FOUND" },
          });
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            authOptions: [
              { id: "provider-login", label: "Provider", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      const signIn = () => page.querySelector<HTMLButtonElement>(selector)!;
      signIn().click();
      await waitForFast(() => expect(page.textContent).toContain(failure));
      [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
        .find(
          (button) =>
            button.textContent?.trim() === (outcome === "validation error" ? "Cancel" : "Close"),
        )!
        .click();
      await page.updateComplete;
      if (outcome === "validation error") {
        await waitForFast(() =>
          expect(page.textContent).toContain("Setup is finishing the current step"),
        );
        expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      } else {
        expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      }
      expect(signIn().disabled).toBe(true);
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).not.toBeNull();
      signIn().click();
      expect(request.mock.calls.filter(([method]) => method === startMethod)).toHaveLength(1);
      expect(request.mock.calls.some(([method]) => method === "openclaw.setup.verify")).toBe(false);
      expect(page.textContent).not.toContain("Connection verified");
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { replacement: "same page", terminal: "busy" },
    { replacement: "new authenticated context", terminal: "cancelled" },
  ])(
    "does not clear a replacement sign-in after late $terminal ($replacement)",
    async ({ replacement, terminal }) => {
      const original = createFirstRunContext();
      const cancelled = createDeferred<unknown>();
      const result = {
        ...detection,
        authOptions: [
          { id: "provider-login", label: "Provider", kind: "oauth" as const, featured: true },
        ],
      };
      let startCount = 0;
      const respond = async (method: string) => {
        if (method === "openclaw.setup.auth.start") {
          if (terminal === "busy" && startCount++ === 0) {
            return await cancelled.promise;
          }
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: { id: "login", type: "text", message: "Complete login" },
          };
        }
        if (method === "wizard.cancel") {
          if (terminal === "busy") {
            throw new Error("wizard not found");
          }
          return await cancelled.promise;
        }
        if (method === "openclaw.setup.detect") {
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      };
      original.request.mockImplementation(respond);
      let { page } = await mountPage(original.context, {
        state: { phase: "ready", result },
        client: original.client,
        firstRun: true,
      });
      const signIn = () =>
        page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!;
      signIn().click();
      await waitForFast(() =>
        expect(original.request).toHaveBeenCalledWith(
          "openclaw.setup.auth.start",
          { sessionId: expect.any(String), agentId: "main", authChoice: "provider-login" },
          { timeoutMs: null },
        ),
      );
      [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
        .find((button) => button.textContent?.trim() === "Cancel")!
        .click();
      await waitForFast(() =>
        expect(original.request).toHaveBeenCalledWith(
          "wizard.cancel",
          { sessionId: expect.any(String) },
          { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS },
        ),
      );
      // Explicitly leaving first-run setup releases its intent. Re-entering is
      // a distinct attempt; the old cancellation acknowledgement is still pending.
      page.routeData = { ...page.routeData!, firstRun: false };
      await page.updateComplete;
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
      const next = replacement === "new authenticated context" ? createFirstRunContext() : original;
      if (next !== original) {
        next.context.gateway.connection.token = "replacement-test-auth";
        next.request.mockImplementation(respond);
      }
      if (replacement !== "same page") {
        unmountModelSetupPage(page);
        page.remove();
        ({ page } = await mountPage(next.context, {
          state: { phase: "ready", result },
          client: next.client,
          firstRun: true,
        }));
      } else {
        page.routeData = { ...page.routeData!, firstRun: true };
        await page.updateComplete;
      }
      await waitForFast(() => expect(signIn()).not.toBeNull());
      signIn().click();
      await waitForFast(() => expect(page.textContent).toContain("Complete login"));
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");
      expect(receipt).not.toBeNull();
      if (terminal === "busy") {
        cancelled.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Setup busy",
            details: { code: "SETUP_ADMISSION_BUSY" },
          }),
        );
      } else {
        cancelled.resolve({ status: terminal });
      }
      await waitForFast(() =>
        expect(
          original.request.mock.settledResults.every((entry) => entry.type !== "incomplete"),
        ).toBe(true),
      );
      await page.updateComplete;
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(receipt);
      expect(page.textContent).toContain("Complete login");
      expect(original.context.navigate).not.toHaveBeenCalled();
      expect(next.context.navigate).not.toHaveBeenCalled();
    },
  );

  it("retires an expired activation during synchronous receipt notification without reviving it", () => {
    const { context } = createFirstRunContext();
    const routeData = {
      firstRun: true,
      state: { phase: "ready" as const, result: detection },
      connection: {
        client: context.gateway.snapshot.client,
        hello: context.gateway.snapshot.hello,
        agentId: "main",
      },
    };
    const setup = new FirstRunSetup({
      context: () => context,
      routeData: () => routeData,
      pageState: () => routeData.state,
      activationState: () => ({ phase: "idle" }),
      actionsDisabled: () => false,
      canUseSetup: () => true,
      canVerify: () => true,
      verify: async () => undefined,
      setVerifyState: () => undefined,
      setActivationState: () => undefined,
      setRefreshWarning: () => undefined,
      resumeWizard: () => undefined,
      closeWizard: () => undefined,
      notify: () => undefined,
    });
    const notify = vi.fn();
    const unsubscribe = setup.subscribe(notify);
    try {
      const activation = setup.beginActivation({ kind: "provider-auth" });
      expect(activation).not.toBeNull();
      vi.spyOn(Date, "now").mockReturnValue(activation!.deadlineMs + 1);
      setup.recordActivation(activation, {
        done: true,
        status: "done",
        modelActivation: { modelRef: "synthetic/model" },
      });
      expect(notify).toHaveBeenCalledOnce();
      expect(setup.unresolved).toBe(false);
      expect(setup.ownsActivation(activation)).toBe(false);
      setup.finishActivation({ ok: true, modelRef: "synthetic/model" }, "provider-auth", null);
      expect(context.navigate).not.toHaveBeenCalled();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    } finally {
      unsubscribe();
      setup.dispose();
    }
  });

  it.each([
    { entry: "manual key", boundary: "reply", changed: "auth" },
    { entry: "provider sign-in", boundary: "refresh", changed: "agent" },
  ])(
    "fences $entry success when $changed retires it during $boundary",
    async ({ entry, boundary, changed }) => {
      const reply = createDeferred<unknown>();
      const refreshing = createDeferred();
      const refresh = createDeferred();
      const { context, client, request } = createFirstRunContext(undefined, async () => {
        refreshing.resolve();
        await refresh.promise;
      });
      const activatedMethod =
        entry === "manual key" ? "openclaw.setup.activate.start" : "wizard.next";
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        if (method === activatedMethod) {
          return await reply.promise;
        }
        if (method === "openclaw.setup.detect") {
          return detection;
        }
        if (method === "wizard.cancel") {
          return { status: "running" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            manualProviders: [{ id: "provider", label: "Provider" }],
            authOptions: [
              { id: "provider-login", label: "Provider", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      if (entry === "manual key") {
        await selectManualProvider(page, "provider");
        const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = "test-only-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      } else {
        page
          .querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!
          .click();
      }
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === activatedMethod)).toBe(true),
      );
      const success = {
        done: true,
        status: "done",
        modelActivation: { modelRef: "provider/previous", latencyMs: 31 },
      };
      if (boundary === "refresh") {
        reply.resolve(success);
        await refreshing.promise;
      }
      if (changed === "auth") {
        context.gateway.connection.token = "replacement-auth";
      }
      if (changed === "agent") {
        context.agentSelection.state.selectedId = "research";
      }
      await page.updateComplete;
      reply.resolve(success);
      refresh.resolve();
      await waitForFast(() =>
        expect(context.runtimeConfig.runExternalMutation).toHaveResolvedWith(
          expect.objectContaining({ ok: true }),
        ),
      );
      await page.updateComplete;
      expect(page.textContent).not.toContain("Connection verified");
      expect(page.textContent).not.toContain("Cannot read properties");
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );

  it("preserves replacement ownership after a late manual busy rejection", async () => {
    const { context, client, request } = createFirstRunContext();
    const rejected = createDeferred<unknown>();
    request.mockReturnValue(rejected.promise);
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          manualProviders: [{ id: "provider-key", label: "Provider key" }],
        },
      },
      client,
      firstRun: true,
    });
    await selectManualProvider(page, "provider-key");
    const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = "test-only-provider-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const replacement = persistFirstRunActivationReceipt(
      {
        ...context,
        gateway: {
          ...context.gateway,
          connection: { ...context.gateway.connection, token: "replacement-auth" },
        },
      },
      { kind: "provider-auth", modelRef: "provider/replacement" },
    );
    rejected.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Provider rejected this test key",
        details: { code: "SETUP_ADMISSION_BUSY" },
      }),
    );
    await waitForFast(() =>
      expect(context.runtimeConfig.runExternalMutation).toHaveResolvedWith(
        expect.objectContaining({ ok: true }),
      ),
    );
    await page.updateComplete;
    expect(page.textContent).not.toContain("Provider rejected this test key");
    expect(page.textContent).not.toContain("Cannot read properties");
    expect(page.textContent).not.toContain("Connection verified");
    expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(
      JSON.stringify(replacement),
    );
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["error", "reconnect"],
    ["cancelled", "unmount"],
    ["running", "unmount"],
  ])(
    "only releases first-run intent after a confirmed negative terminal result (%s, %s)",
    async (cancelStatus, lifecycle) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      const cancelled = createDeferred<unknown>();
      let serverStatus: "running" | "cancelled" | "error" = "running";
      const result = {
        ...detection,
        authOptions: [
          { id: "provider-login", label: "Provider", kind: "oauth" as const, featured: true },
        ],
      };
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { sessionId: "auth", done: false, status: "running" };
        }
        if (method === "wizard.next") {
          if (serverStatus !== "running") {
            return { done: true, status: serverStatus };
          }
          return {
            done: false,
            status: "running",
            step: { id: "login", type: "text", message: "Complete login" },
          };
        }
        if (method === "wizard.cancel") {
          // The server settles its status before sending the reply. A resumed
          // next request sees that outcome even while this transport is delayed.
          if (cancelStatus === "cancelled" || cancelStatus === "error") {
            serverStatus = cancelStatus;
          }
          return await cancelled.promise;
        }
        if (method === "openclaw.setup.detect") {
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      });
      let { page } = await mountPage(context, {
        state: { phase: "ready", result },
        client,
        firstRun: true,
      });
      page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "openclaw.setup.auth.start",
          { sessionId: expect.any(String), agentId: "main", authChoice: "provider-login" },
          { timeoutMs: null },
        ),
      );
      const cancel = [
        ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
      ].find((button) => button.textContent?.trim() === "Cancel")!;
      cancel.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "wizard.cancel",
          { sessionId: expect.any(String) },
          { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS },
        ),
      );
      await page.updateComplete;
      expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).not.toBeNull();
      if (lifecycle === "reconnect") {
        publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        await page.updateComplete;
        publishGatewaySnapshot({ ...snapshot, hello: { ...snapshot.hello } });
      } else if (lifecycle === "unmount") {
        unmountModelSetupPage(page);
        page.remove();
      }
      await page.updateComplete;
      cancelled.resolve({ status: cancelStatus });
      await waitForFast(() => {
        const cancelIndex = request.mock.calls.findIndex(([method]) => method === "wizard.cancel");
        expect(request.mock.settledResults[cancelIndex]?.type).toBe("fulfilled");
      });
      if (lifecycle === "reconnect") {
        const terminalClose = () =>
          [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
            (button) => button.textContent?.trim() === "Close",
          );
        await waitForFast(() =>
          expect(
            page.querySelector("openclaw-modal-dialog") === null || terminalClose() !== undefined,
          ).toBe(true),
        );
        terminalClose()?.click();
        await page.updateComplete;
        expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      }
      if (lifecycle === "unmount") {
        ({ page } = await mountPage(context, {
          state: { phase: "ready", result },
          client,
          firstRun: true,
        }));
      }
      await waitForFast(() => {
        const button = page.querySelector<HTMLButtonElement>(
          '[data-auth-choice="provider-login"] button',
        );
        expect(button).not.toBeNull();
        expect(button!.disabled).toBe(cancelStatus !== "cancelled");
      });
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1") === null).toBe(
        cancelStatus === "cancelled",
      );
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );
});
