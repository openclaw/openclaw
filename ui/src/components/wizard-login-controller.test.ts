import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render, type ReactiveControllerHost } from "lit";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient, GatewayRequestError } from "../api/gateway.ts";
import type { WizardNextResult } from "../api/types.ts";
import * as uuid from "../lib/uuid.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { WizardLoginController } from "./wizard-login-controller.ts";

it.each([
  ["mcp.authLogin", "terminal during status", "cancelled"],
  ["models.authLogin", "terminal during status", "cancelled"],
  ["mcp.authLogin", "failed cancellation", "cancelled"],
  ["models.authLogin", "failed cancellation", "cancelled"],
  ["mcp.authLogin", "failed status", "cancelled"],
  ["models.authLogin", "failed status", "cancelled"],
  ["mcp.authLogin", "failed cancellation", "done"],
  ["models.authLogin", "failed cancellation", "done"],
] as const)(
  "settles %s after %s with %s without poisoning a new sign-in",
  async (startMethod, ordering, terminal) => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const generateUUID = vi
      .spyOn(uuid, "generateUUID")
      .mockReturnValueOnce(firstId)
      .mockReturnValue(secondId);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const nextResult = createDeferred<WizardNextResult>();
    const nextRequested = createDeferred();
    const cancellationResult = createDeferred<{ status: "cancelled" }>();
    const cancellationRequested = createDeferred();
    const statusResult = createDeferred<{ status: "cancelled" }>();
    const statusRequested = createDeferred();
    const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
    let starts = 0;
    let nextRequests = 0;
    const request = vi
      .spyOn(client, "request")
      .mockImplementation(async (method, params, options) => {
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
            return {
              done: false,
              status: "running",
              step: {
                id: "browser",
                type: "progress",
                executor: "gateway",
                externalUrl: "https://provider.example/authorize",
              },
            };
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
    const container = document.createElement("div");
    document.body.append(container);
    const host = {
      addController: vi.fn(),
      removeController: vi.fn(),
      updateComplete: Promise.resolve(true),
      requestUpdate: () =>
        render(controller.render({ doneMessage: "Authentication saved" }), container),
    } satisfies ReactiveControllerHost;
    const controller = new WizardLoginController(host, {
      getClient: () => client,
      getAgentId: () => "main",
      onClose: () => controller.reset(),
      requestFailedMessage: () => "failed",
      sessionExpiredMessage: () => "expired",
    });
    const start = () => {
      controller.runner.prepareSignIn("oauth", "docs");
      return startMethod === "mcp.authLogin"
        ? controller.runner.startMcpLogin("docs")
        : controller.runner.start("provider", "models.authLogin");
    };
    try {
      const first = start();
      await nextRequested.promise;
      expectDefined(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Cancel",
        ),
        "Cancel control",
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
      expect(nextRequests).toBe(2);
      if (terminal === "done") {
        expect(container.textContent).toContain("Authentication saved");
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expectDefined(
          [...container.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Close",
          ),
          "Close control",
        ).click();
      }
      await waitForFast(() => {
        expect(controller.runner.state.phase).toBe("idle");
        expect(controller.cancelling).toBe(false);
      });
      await start();
      expect(starts).toBe(2);
      expect(controller.runner.state.phase).toBe("done");
      expect(container.textContent).toContain("Authentication saved");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      cancellationResult.resolve({ status: "cancelled" });
      statusResult.resolve({ status: "cancelled" });
      nextResult.resolve({ done: true, status: "cancelled" });
      await controller.runner.cancel();
      render(nothing, container);
      container.remove();
      request.mockRestore();
      generateUUID.mockRestore();
      open.mockRestore();
    }
  },
);
