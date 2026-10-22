/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  chooseLogin,
  loginHarness,
  openLogin,
  openPicker,
} from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  waitForProviders,
  modelPicker,
  openModelPicker,
  submitCredential,
  unmountPage,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("keeps the credential step disabled until its configuration refresh settles", async () => {
  const { context, request } = createHarness("writer");
  await context.runtimeConfig.ensureLoaded();
  const originalRequest = request.getMockImplementation()!;
  const refresh = createDeferred();
  let holdRefresh = false;
  let refreshing = false;
  let nextCalls = 0;
  request.mockImplementation(async (method, ...args) => {
    if (method === "models.authStatus") {
      return {
        ts: 1,
        providers: [],
        providerCapabilities: [
          {
            provider: "example",
            apiKeySupported: true,
            loginOptions: [
              {
                id: "example-secret",
                brandId: "example",
                label: "Example API key",
                kind: "secret",
              },
            ],
          },
        ],
      };
    }
    if (method === "models.authLogin") {
      return { done: false, status: "running" };
    }
    if (method === "wizard.next") {
      if (++nextCalls > 1) {
        return { done: true, status: "done" };
      }
      holdRefresh = true;
      return {
        done: false,
        status: "running",
        step: {
          id: "credential",
          type: "text",
          sensitive: true,
          message: "Enter your key",
          initialValue: "synthetic-test-credential",
        },
      };
    }
    if (method === "config.get" && holdRefresh) {
      refreshing = true;
      await refresh.promise;
    }
    return originalRequest(method, ...args);
  });
  const page = appendPage(context);
  try {
    await chooseLogin(page);
    await waitForSolid(() => expect(refreshing).toBe(true));
    const input = page.querySelector<HTMLInputElement>('input[name="wizard-text"]')!;
    const submit = page.querySelector<HTMLButtonElement>(
      '.wizard-step__form button[type="submit"]',
    )!;
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);

    holdRefresh = false;
    refresh.resolve();
    await waitForSolid(() => {
      expect(page.querySelector('input[name="wizard-text"]')).toBe(input);
      expect(input.disabled).toBe(false);
      expect(submit.disabled).toBe(false);
    });
    submit.click();
    await waitForSolid(() =>
      expect(page.querySelector(".model-setup-wizard--done")).not.toBeNull(),
    );
    expect(nextCalls).toBe(2);
  } finally {
    refresh.resolve();
    unmountPage(page);
  }
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

it("retains search and Retry controls through admitted core error feedback", async () => {
  const { context, request } = createHarness("main");
  const initialRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method, ...args) =>
    method === "models.authStatus" ? createAuthStatus() : initialRequest(method, ...args),
  );
  const page = appendPage(context);
  await waitForProviders(page);
  const row = page.querySelector('[data-provider-id="openai"]');
  const primary = modelPicker(page, "primary");
  const refresh = page.querySelector<HTMLButtonElement>(".model-providers__refresh-button")!;
  const search = page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  search.value = "openai";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  search.focus();
  const first = createDeferred<unknown>();
  const retry = createDeferred<unknown>();
  let reads = 0;
  const originalRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method, ...args) => {
    if (method === "models.authStatus") {
      return reads++ === 0 ? first.promise : retry.promise;
    }
    return originalRequest(method, ...args);
  });
  page.view.props.onRefresh();
  await waitForSolid(() => expect(reads).toBe(1));
  await waitForSolid(() => expect(refresh.disabled).toBe(true));
  expect(page.querySelector('[data-provider-id="openai"]')).toBe(row);
  expect(modelPicker(page, "primary")).toBe(primary);
  expect(page.querySelector(".model-providers__search input")).toBe(search);
  expect(document.activeElement).toBe(search);
  first.reject(new Error("Core status unavailable"));
  await waitForSolid(() =>
    expect(page.renderRoot.textContent).toContain("Core status unavailable"),
  );
  expect(refresh.disabled).toBe(false);
  const receipt = page.view.props.coreReceipt;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  expect(page.view.props.coreReceipt).toBe(receipt);
  expect(
    page
      .querySelector(".model-providers__provider-list")
      ?.textContent?.match(/Core status unavailable/g),
  ).toHaveLength(1);
  const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Retry",
  )!;
  button.focus();
  button.click();
  await waitForSolid(() => expect(reads).toBe(2));
  await waitForSolid(() => expect(refresh.disabled).toBe(true));
  expect(button.isConnected).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(page.renderRoot.textContent).toContain("Core status unavailable");
  expect(page.querySelector(".model-providers__search input")).toBe(search);
  expect(search.value).toBe("openai");
  retry.resolve(createAuthStatus());
  await waitForSolid(() =>
    expect(page.renderRoot.textContent).not.toContain("Core status unavailable"),
  );
  expect(refresh.disabled).toBe(false);
  expect(modelPicker(page, "primary")).toBe(primary);
  expect(page.querySelector('[data-provider-id="openai"]')).not.toBeNull();
  expect(page.querySelector(".model-providers__search input")).toBe(search);
});
