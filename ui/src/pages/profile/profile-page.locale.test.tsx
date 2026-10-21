/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../app/user-prefs-request.ts";
import { i18n, t, translateActive } from "../../i18n/index.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createConnectedContext, mountProfilePage } from "./profile-page.test-support.tsx";

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

it("refreshes translated copy when the locale changes while mounted", async () => {
  const { context } = createConnectedContext(vi.fn() as GatewayBrowserClient["request"]);
  context.gateway.snapshot.phase = "stopped";
  context.gateway.snapshot.client = null;
  const page = mountProfilePage(context);
  flush();

  const note = page.querySelector(".settings-empty");
  const englishNote = note?.textContent?.trim();

  const localeErrors: Array<{
    message: string;
    error: { name: string; message: string } | null;
  }> = [];
  const forwardConsoleError = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((...args) => {
    const [message, detail] = args;
    localeErrors.push({
      message: typeof message === "string" ? message : `<${typeof message}>`,
      error:
        detail instanceof Error
          ? {
              name: detail.name,
              message: detail.message,
            }
          : null,
    });
    forwardConsoleError(...args);
  });

  await i18n.setLocale("de");
  const activeLocale = i18n.getLocale();
  const localeDiagnostics = {
    activeLocale,
    requestedLocale: i18n.getRequestedLocale(),
    errors: localeErrors,
  };
  expect(activeLocale, JSON.stringify(localeDiagnostics)).toBe("de");
  expect(translateActive("profilePage.offline")).toBeDefined();
  expect(translateActive("profilePage.offline")).not.toBe(englishNote);
  flush();

  expect(note?.textContent?.trim()).toBe(t("profilePage.offline"));
  expect(note?.textContent?.trim()).not.toBe(englishNote);
});
