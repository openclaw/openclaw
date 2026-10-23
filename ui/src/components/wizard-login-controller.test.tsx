import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient, GatewayRequestError } from "../api/gateway.ts";
import type { WizardNextResult } from "../api/types.ts";
import * as uuid from "../lib/uuid.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  createWizardLogin,
  WizardLogin,
  type WizardLoginState,
} from "./wizard-login-controller.tsx";

afterEach(() => vi.restoreAllMocks());

function loginFixture(client: GatewayBrowserClient, onStart?: (login: WizardLoginState) => void) {
  let controller!: WizardLoginState;
  const view = mountSolid(() => {
    controller = createWizardLogin({
      getClient: () => client,
      getAgentId: () => "main",
      onClose: () => controller.reset(),
      requestFailedMessage: () => "failed",
      sessionExpiredMessage: () => "expired",
    });
    return (
      <>
        {onStart && <button onClick={() => onStart(controller)}>Sign in</button>}
        <WizardLogin controller={controller} options={{ doneMessage: "Authentication saved" }} />
      </>
    );
  });
  const clickButton = (label: string) =>
    expectDefined(
      [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === label,
      ),
      `${label} control`,
    ).click();
  return { ...view, controller, clickButton };
}

function progress(step: { id: string; message?: string; externalUrl?: string }): WizardNextResult {
  return {
    done: false,
    status: "running",
    step: { ...step, type: "progress", executor: "gateway" },
  };
}

it("retains the draft and controls through a failed cancellation and a held retry", async () => {
  const firstCancellation = createDeferred<{ status: "running" }>();
  const secondCancellation = createDeferred<{ status: "running" }>();
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  let cancellations = 0;
  vi.spyOn(client, "request").mockImplementation(async (method) => {
    if (method === "models.authLogin") {
      return { sessionId: "00000000-0000-4000-8000-000000000003", done: false, status: "running" };
    }
    if (method === "wizard.next") {
      return { done: false, status: "running", step: { id: "credentials", type: "text" } };
    }
    if (method === "wizard.cancel") {
      cancellations += 1;
      if (cancellations === 3) {
        return { status: "cancelled" };
      }
      return await (cancellations === 1 ? firstCancellation.promise : secondCancellation.promise);
    }
    if (method === "wizard.status") {
      return { status: "cancelled" };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const view = loginFixture(client);
  const { container, controller, clickButton } = view;
  try {
    await controller.runner.start("provider", "models.authLogin");
    flush();
    const input = expectDefined(container.querySelector("input"), "credential input");
    input.value = "retained draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    clickButton("Cancel");
    clickButton("Cancel");
    expect(cancellations).toBe(1);
    flush();
    expect(controller.cancelling).toBe(true);
    firstCancellation.reject(new Error("Cancellation response lost"));
    await waitForFast(() => expect(container.textContent).toContain("Cancellation response lost"));
    expect(controller.cancelling).toBe(false);
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("retained draft");

    clickButton("Cancel");
    flush();
    expect(controller.cancelling).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("input")).toBe(input);
    secondCancellation.resolve({ status: "running" });
    await waitForFast(() => {
      expect(controller.cancelling).toBe(false);
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Cancellation response lost");
    expect(controller.runner.state.phase).toBe("step");
    expect(input.value).toBe("retained draft");
    expect(cancellations).toBe(2);
    clickButton("Cancel");
    await waitForFast(() => {
      expect(controller.runner.state.phase).toBe("idle");
      expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    });
  } finally {
    firstCancellation.resolve({ status: "running" });
    secondCancellation.resolve({ status: "running" });
    view.unmount();
  }
});

it("retires an active sign-in when its owner is removed without publishing during teardown", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000003";
  vi.spyOn(uuid, "generateUUID").mockReturnValue(sessionId);
  const next = createDeferred<WizardNextResult>();
  const nextRequested = createDeferred<AbortSignal>();
  const cancellation = createDeferred<{ status: "cancelled" }>();
  const cancelled = createDeferred();
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  let nextRequests = 0;
  vi.spyOn(client, "request").mockImplementation(async (method, params, options) => {
    if (method === "models.authLogin") {
      return { sessionId, done: false, status: "running" };
    }
    if (method === "wizard.next") {
      if (++nextRequests === 1) {
        return progress({ id: "credentials", message: "Waiting for credentials" });
      }
      nextRequested.resolve(expectDefined(options?.signal, "sign-in request signal"));
      return await next.promise;
    }
    if (method === "wizard.cancel") {
      expect(params).toEqual({ sessionId, closeInput: true });
      cancelled.resolve();
      return await cancellation.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  let signIn: Promise<unknown> | undefined;
  const view = loginFixture(client, (login) => {
    login.runner.prepareSignIn("secret", "provider");
    signIn = login.runner.start("provider", "models.authLogin");
  });
  const { container, clickButton } = view;
  try {
    clickButton("Sign in");
    const signal = await nextRequested.promise;
    flush();
    expect(container.textContent).toContain("Waiting for credentials");
    expect(() => view.unmount()).not.toThrow();
    expect(signal.aborted).toBe(true);
    await cancelled.promise;
    next.resolve({ done: true, status: "done" });
    cancellation.resolve({ status: "cancelled" });
    await signIn;
    flush();
    expect(container.textContent).toBe("");
  } finally {
    next.resolve({ done: true, status: "cancelled" });
    cancellation.resolve({ status: "cancelled" });
    view.unmount();
  }
});

it.each([
  ["mcp.authLogin", "terminal during status", "cancelled"],
  ["mcp.authLogin", "failed cancellation", "cancelled"],
  ["models.authLogin", "failed status", "cancelled"],
  ["models.authLogin", "failed cancellation", "done"],
] as const)(
  "settles %s after %s with %s without poisoning a new sign-in",
  async (startMethod, ordering, terminal) => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    vi.spyOn(uuid, "generateUUID").mockReturnValueOnce(firstId).mockReturnValue(secondId);
    vi.spyOn(window, "open").mockReturnValue(null);
    const nextResult = createDeferred<WizardNextResult>();
    const nextRequested = createDeferred();
    const cancellationResult = createDeferred<{ status: "cancelled" }>();
    const cancellationRequested = createDeferred();
    const statusResult = createDeferred<{ status: "cancelled" }>();
    const statusRequested = createDeferred();
    const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
    let starts = 0;
    let nextRequests = 0;
    vi.spyOn(client, "request").mockImplementation(async (method, params, options) => {
      if (method === startMethod) {
        starts += 1;
        return { sessionId: starts === 1 ? firstId : secondId, done: false, status: "running" };
      }
      if (method === "wizard.cancel") {
        cancellationRequested.resolve();
        return await cancellationResult.promise;
      }
      if (method === "wizard.status") {
        const signal = expectDefined(options?.signal, "status session signal");
        const abort = () => statusResult.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        statusRequested.resolve();
        try {
          return await statusResult.promise;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
      if (method === "wizard.next") {
        expect(params).toEqual({ sessionId: starts === 1 ? firstId : secondId });
        if (starts === 2) {
          return { done: true, status: "done" };
        }
        nextRequests += 1;
        if (nextRequests === 1) {
          return progress({ id: "browser", externalUrl: "https://provider.example/authorize" });
        }
        if (nextRequests === 2) {
          nextRequested.resolve();
          return await nextResult.promise;
        }
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Wizard session was purged",
          details: { code: "WIZARD_NOT_FOUND" },
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const view = loginFixture(client);
    const { container, controller, clickButton } = view;
    const start = () => {
      controller.runner.prepareSignIn("oauth", "docs");
      return startMethod === "mcp.authLogin"
        ? controller.runner.startMcpLogin("docs")
        : controller.runner.start("provider", "models.authLogin");
    };
    try {
      const first = start();
      await nextRequested.promise;
      flush();
      // Browser sign-in has no footer; the dialog's corner control cancels it.
      expectDefined(
        container.querySelector<HTMLButtonElement>('[aria-label="Cancel sign-in"]'),
        "corner cancel control",
      ).click();
      await cancellationRequested.promise;
      if (ordering === "failed cancellation") {
        cancellationResult.reject(new Error("Cancellation response lost"));
        await waitForFast(() =>
          expect(container.textContent).toContain("Cancellation response lost"),
        );
      } else {
        cancellationResult.resolve({ status: "cancelled" });
        await statusRequested.promise;
        if (ordering === "failed status") {
          statusResult.reject(new Error("Status response lost"));
          await waitForFast(() => expect(container.textContent).toContain("Status response lost"));
        }
      }
      nextResult.resolve({ done: true, status: terminal });
      await first;
      flush();
      expect(nextRequests).toBe(2);
      if (terminal === "done") {
        expect(container.textContent).toContain("Authentication saved");
        expect(container.querySelector('[role="alert"]')).toBeNull();
        clickButton("Close");
      }
      await waitForFast(() => {
        expect(controller.runner.state.phase).toBe("idle");
        expect(controller.cancelling).toBe(false);
      });
      await start();
      flush();
      expect(starts).toBe(2);
      expect(controller.runner.state.phase).toBe("done");
      expect(container.textContent).toContain("Authentication saved");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      cancellationResult.resolve({ status: "cancelled" });
      statusResult.resolve({ status: "cancelled" });
      nextResult.resolve({ done: true, status: "cancelled" });
      await controller.runner.cancel();
      view.unmount();
    }
  },
);
