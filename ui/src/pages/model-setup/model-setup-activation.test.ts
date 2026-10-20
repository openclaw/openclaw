/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { persistFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import { FirstRunSetup } from "./first-run-setup.ts";
import {
  waitForText,
  runningStep,
  authButton,
  pageButton,
  activated,
  authOption,
  mockRequests,
  useFirstRunFixtures,
  pendingReceipt,
  modalButton,
  callsFor,
  enterManualKey,
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountDetection,
  reconnectGateway,
  waitForModelSetupDetection,
} from "./model-setup-first-run.test-support.ts";
import { MODEL_SETUP_AUTH_START_TIMEOUT_MS } from "./state.ts";
import { unmountModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

async function startAndCancelSignIn(
  page: ParentNode,
  request: ReturnType<typeof createFirstRunContext>["request"],
) {
  authButton(page, "provider-login")!.click();
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.auth.start",
      { sessionId: expect.any(String), agentId: "main", authChoice: "provider-login" },
      { timeoutMs: null },
    ),
  );
  modalButton(page, "Cancel")!.click();
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith(
      "wizard.cancel",
      { sessionId: expect.any(String) },
      { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS },
    ),
  );
}

describe("ModelSetupPage first-run activation ownership", () => {
  useFirstRunFixtures("test-device-key");
  it("keeps first-run activation owned through an equivalent route-data refresh", async () => {
    const { context, client, request } = createFirstRunContext();
    const response = createDeferred<unknown>();
    mockRequests(request, {
      "openclaw.setup.detect": () => detection,
      "openclaw.setup.activate.start": () => response.promise,
    });
    const { page } = await mountDetection(context, client, {
      candidates: [candidate("openai-api-key", "provider/verified", true)],
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    const success = activated("provider/verified");
    try {
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      const receipt = pendingReceipt();
      page.routeData = { firstRun: true };
      await page.updateComplete;
      expect(request).toHaveBeenCalledOnce();
      expect(pendingReceipt()).toBe(receipt);
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
      mockRequests(request, {
        "openclaw.setup.auth.start": () => ({ sessionId: "auth", done: false, status: "running" }),
        [activatedMethod]: async () => {
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
        },
        "openclaw.setup.detect": () => ({
          ...detection,
          configuredModel: "provider/current",
          setupComplete: true,
        }),
        "openclaw.setup.verify": () => ({ ok: true, modelRef: "provider/current", latencyMs: 31 }),
        "wizard.cancel": () => ({ status: "running" }),
      });
      const { page } = await mountDetection(context, client, {
        manualProviders: [{ id: "provider-key", label: "Provider key" }],
        authOptions: [authOption("provider-login", "Provider login")],
      });
      if (entry === "manual key") {
        await enterManualKey(page, "provider-key", "test-only-provider-key");
      } else {
        authButton(page, "provider-login")!.click();
      }
      await waitForFast(() => expect(releaseActivation).toBeTypeOf("function"));
      const receipt = pendingReceipt()!;
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
        await waitForText(page, "Gateway no longer has this setup session");
        expect(page.textContent).not.toContain("Waiting for it to reconnect");
        modalButton(page, "Close")!.click();
        await page.updateComplete;
      }
      await waitForText(page, "Verify & use selected model");
      await waitForModelSetupDetection(page);
      expect(callsFor(request, "openclaw.setup.verify")).toHaveLength(0);
      expect(context.navigate).not.toHaveBeenCalled();
      pageButton(page, ".model-setup__recovery .btn.primary")!.click();
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      releaseActivation?.(activated("provider/late-other"));
      await page.updateComplete;
      expect(callsFor(request, activatedMethod)).toHaveLength(entry === "provider sign-in" ? 2 : 1);
      expect(request.mock.calls.filter(([method]) => method.endsWith(".start"))).toHaveLength(1);
      expect(context.navigate).toHaveBeenCalledOnce();
      expect(pendingReceipt()).toBeNull();
    },
  );

  it.each(["wrong-code start", "validation error"])(
    "retains unresolved auth after %s",
    async (outcome) => {
      const { context, client, request } = createFirstRunContext();
      const startMethod = "openclaw.setup.auth.start";
      const selector = '[data-auth-choice="provider-login"] button';
      const failure = "Provider could not finish this sign-in";
      mockRequests(request, {
        [startMethod]: () => {
          if (outcome === "wrong-code start") {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: failure,
              details: { code: "SETUP_ADMISSION_BUSY" },
              retryable: true,
            });
          }
          return { done: false, status: "running" };
        },
        "wizard.next": () => ({
          done: false,
          status: "running",
          error: failure,
          step: { id: "login", type: "text" },
        }),
        "wizard.cancel": () => {
          if (outcome === "validation error") {
            return { status: "running" };
          }
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "wizard not found",
            details: { code: "WIZARD_NOT_FOUND" },
          });
        },
      });
      const { page } = await mountDetection(context, client, {
        authOptions: [authOption("provider-login")],
      });
      const signIn = () => pageButton(page, selector)!;
      signIn().click();
      await waitForText(page, failure);
      modalButton(page, outcome === "validation error" ? "Cancel" : "Close")!.click();
      await page.updateComplete;
      if (outcome === "validation error") {
        await waitForText(page, "Setup is finishing the current step");
        expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      } else {
        expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      }
      expect(signIn().disabled).toBe(true);
      expect(pendingReceipt()).not.toBeNull();
      signIn().click();
      expect(callsFor(request, startMethod)).toHaveLength(1);
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
        authOptions: [authOption("provider-login")],
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
          return runningStep({ id: "login", type: "text", message: "Complete login" });
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
      let { page } = await mountDetection(original.context, original.client, result);
      const signIn = () => authButton(page, "provider-login")!;
      await startAndCancelSignIn(page, original.request);
      // Explicitly leaving first-run setup releases its intent. Re-entering is
      // a distinct attempt; the old cancellation acknowledgement is still pending.
      page.routeData = { ...page.routeData!, firstRun: false };
      await page.updateComplete;
      expect(pendingReceipt()).toBeNull();
      const next = replacement === "new authenticated context" ? createFirstRunContext() : original;
      if (next !== original) {
        next.context.gateway.connection.token = "replacement-test-auth";
        next.request.mockImplementation(respond);
      }
      if (replacement !== "same page") {
        unmountModelSetupPage(page);
        page.remove();
        ({ page } = await mountDetection(next.context, next.client, result));
      } else {
        page.routeData = { ...page.routeData!, firstRun: true };
        await page.updateComplete;
      }
      await waitForFast(() => expect(signIn()).not.toBeNull());
      signIn().click();
      await waitForText(page, "Complete login");
      const receipt = pendingReceipt();
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
      expect(pendingReceipt()).toBe(receipt);
      expect(page.textContent).toContain("Complete login");
      expect(original.context.navigate).not.toHaveBeenCalled();
      expect(next.context.navigate).not.toHaveBeenCalled();
    },
  );

  it("retires an expired activation during synchronous receipt notification without reviving it", () => {
    const { context } = createFirstRunContext();
    const setup = new FirstRunSetup({
      context: () => context,
      routeData: () => ({ firstRun: true }),
      pageState: () => ({ phase: "ready", result: detection }),
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
      setup.recordActivation(activation, activated("synthetic/model"));
      expect(notify).toHaveBeenCalledOnce();
      expect(setup.unresolved).toBe(false);
      expect(setup.ownsActivation(activation)).toBe(false);
      setup.finishActivation({ ok: true, modelRef: "synthetic/model" }, "provider-auth", null);
      expect(context.navigate).not.toHaveBeenCalled();
      expect(pendingReceipt()).toBeNull();
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
      mockRequests(request, {
        "openclaw.setup.auth.start": () => ({ done: false, status: "running" }),
        [activatedMethod]: async () => await reply.promise,
        "openclaw.setup.detect": () => detection,
        "wizard.cancel": () => ({ status: "running" }),
      });
      const { page } = await mountDetection(context, client, {
        manualProviders: [{ id: "provider", label: "Provider" }],
        authOptions: [authOption("provider-login")],
      });
      if (entry === "manual key") {
        await enterManualKey(page, "provider", "test-only-key");
      } else {
        authButton(page, "provider-login")!.click();
      }
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === activatedMethod)).toBe(true),
      );
      const success = activated("provider/previous");
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
    const { page } = await mountDetection(context, client, {
      manualProviders: [{ id: "provider-key", label: "Provider key" }],
    });
    await enterManualKey(page, "provider-key", "test-only-provider-key");
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
    expect(pendingReceipt()).toBe(JSON.stringify(replacement));
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
        authOptions: [authOption("provider-login")],
      };
      mockRequests(request, {
        "openclaw.setup.auth.start": () => ({ sessionId: "auth", done: false, status: "running" }),
        "wizard.next": () => {
          if (serverStatus !== "running") {
            return { done: true, status: serverStatus };
          }
          return runningStep({ id: "login", type: "text", message: "Complete login" });
        },
        "wizard.cancel": async () => {
          // The server settles its status before sending the reply. A resumed
          // next request sees that outcome even while this transport is delayed.
          if (cancelStatus === "cancelled" || cancelStatus === "error") {
            serverStatus = cancelStatus;
          }
          return await cancelled.promise;
        },
        "openclaw.setup.detect": () => result,
      });
      let { page } = await mountDetection(context, client, result);
      await startAndCancelSignIn(page, request);
      await page.updateComplete;
      expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      expect(pendingReceipt()).not.toBeNull();
      if (lifecycle === "reconnect") {
        await reconnectGateway(page, snapshot, publishGatewaySnapshot);
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
        const terminalClose = () => modalButton(page, "Close");
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
        ({ page } = await mountDetection(context, client, result));
      }
      await waitForFast(() => {
        const button = authButton(page, "provider-login");
        expect(button).not.toBeNull();
        expect(button!.disabled).toBe(cancelStatus !== "cancelled");
      });
      expect(pendingReceipt() === null).toBe(cancelStatus === "cancelled");
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );
});
