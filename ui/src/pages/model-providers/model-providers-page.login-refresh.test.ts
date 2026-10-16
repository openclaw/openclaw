/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loginHarness, openLogin, openPicker } from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  modelPicker,
  openModelPicker,
  submitCredential,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it("refreshes the connected provider without reloading usage or replacing other rows", async () => {
  const existingProvider: ModelAuthStatusResult["providers"][number] = {
    provider: "openai",
    displayName: "OpenAI",
    status: "ok",
    profiles: [{ profileId: "openai:existing", type: "token", status: "ok" }],
  };
  const { context, request, answer, publishEvent } = loginHarness({
    providers: [existingProvider],
  });
  const originalRequest = request.getMockImplementation()!;
  let connected = false;
  request.mockImplementation(async (method, ...args) => {
    if (method === "models.authStatus" && connected) {
      return {
        ts: 2,
        providers: [
          existingProvider,
          {
            provider: "example",
            displayName: "Example provider",
            status: "ok",
            profiles: [{ profileId: "example:new", type: "api_key", status: "ok" }],
          },
        ],
      };
    }
    if (method === "models.list") {
      return {
        models: connected
          ? [{ id: "new-model", name: "New account model", provider: "example" }]
          : [],
      };
    }
    return originalRequest(method, ...args);
  });
  const page = appendPage(context);
  await openLogin(page);
  await submitCredential(page);
  const existingRow = page.querySelector('[data-provider-id="openai"]');
  expect(existingRow).not.toBeNull();
  const methods = ["usage.status", "sessions.usage"];
  const before = methods.map(
    (method) => request.mock.calls.filter(([name]) => name === method).length,
  );
  const catalogReads = request.mock.calls.filter(([name]) => name === "models.list").length;
  publishEvent({ type: "event", event: "config.changed", payload: {} });
  publishEvent({ type: "event", event: "config.changed", payload: {} });
  connected = true;

  answer.resolve({ done: true, status: "done" });
  await waitForSolid(() =>
    expect(modelPicker(page, "primary").querySelector<HTMLButtonElement>("button")?.disabled).toBe(
      false,
    ),
  );
  await openModelPicker(page);
  await waitForSolid(() => expect(page.renderRoot.textContent).toContain("New account model"));
  expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull();
  expect(
    methods.map((method) => request.mock.calls.filter(([name]) => name === method).length),
  ).toEqual(before);
  expect(request.mock.calls.filter(([name]) => name === "models.list")).toHaveLength(
    catalogReads + 1,
  );
  expect(page.querySelector('[data-provider-id="openai"]')).toBe(existingRow);
  expect(page.querySelector(".settings-loading-skeleton")).toBeNull();
});

it("keeps rows and offers retry when refreshing saved sign-in status fails", async () => {
  const { context, request, answer } = loginHarness();
  const originalRequest = request.getMockImplementation()!;
  let failStatus = false;
  request.mockImplementation(async (method, ...args) => {
    if (method === "models.authStatus" && failStatus) {
      throw new Error("Status unavailable");
    }
    return originalRequest(method, ...args);
  });
  const page = appendPage(context);
  await openLogin(page);
  await submitCredential(page);
  const existingRows = page.querySelectorAll("[data-provider-id]");
  failStatus = true;
  answer.resolve({ done: true, status: "done" });
  await waitForSolid(() =>
    expect(page.renderRoot.textContent).toContain(
      "Sign-in saved, but refreshing status failed. Retry",
    ),
  );
  expect(page.querySelectorAll("[data-provider-id]")).toEqual(existingRows);
  expect(page.querySelector(".settings-loading-skeleton")).toBeNull();
  failStatus = false;
  const supplementalCalls = request.mock.calls.filter(([method]) =>
    ["usage.status", "sessions.usage"].includes(method),
  ).length;
  const retry = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Retry",
  );
  expect(retry).toBeDefined();
  retry!.click();
  await waitForSolid(() =>
    expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull(),
  );
  expect(page.renderRoot.textContent).not.toContain("refreshing status failed");
  expect(
    request.mock.calls.filter(([method]) => ["usage.status", "sessions.usage"].includes(method)),
  ).toHaveLength(supplementalCalls);
});

it.each(["close", "cancel", "complete"] as const)(
  "reconciles another client's credentials after login %s without restarting usage",
  async (action) => {
    const { context, request, publishEvent, cancel, status, answer } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    let externalUpdate = false;
    request.mockImplementation(async (method, ...args) => {
      if (method === "models.authStatus" && externalUpdate) {
        return {
          ts: 2,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai:new", type: "token", status: "ok" }],
            },
          ],
        };
      }
      return originalRequest(method, ...args);
    });
    const page = appendPage(context);
    if (action === "close") {
      await openPicker(page);
    } else {
      await openLogin(page);
    }
    const usageReads = request.mock.calls.filter(([method]) =>
      ["usage.status", "sessions.usage"].includes(method),
    ).length;
    externalUpdate = true;
    publishEvent({ type: "event", event: "config.changed", payload: {} });
    expect(page.querySelector('[data-provider-id="openai"]')).toBeNull();
    if (action === "complete") {
      answer.resolve({ done: true, status: "done" });
      await submitCredential(page);
    } else if (action === "close") {
      page.querySelector("openclaw-modal-dialog")!.dispatchEvent(new CustomEvent("modal-cancel"));
    } else {
      const dismiss = [
        ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
      ].find((button) => button.textContent?.trim() === "Cancel");
      expect(dismiss).toBeDefined();
      dismiss!.click();
      cancel.resolve({ status: "cancelled" });
      status.resolve({ status: "cancelled" });
    }
    await waitForSolid(() =>
      expect(page.querySelector('[data-provider-id="openai"]')).not.toBeNull(),
    );
    expect(
      request.mock.calls.filter(([method]) => ["usage.status", "sessions.usage"].includes(method)),
    ).toHaveLength(usageReads);
  },
);
