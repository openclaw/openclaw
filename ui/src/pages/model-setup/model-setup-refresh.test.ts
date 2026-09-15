/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createFirstRunContext,
  detection,
  mountPage,
  selectManualProvider,
} from "./model-setup-first-run.test-support.ts";

const inventory: SystemAgentSetupDetectResult = {
  ...detection,
  manualProviders: [{ id: "fixture-key", label: "Fixture provider" }],
};

describe("Model setup refresh continuity", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["success", "failure"] as const)(
    "keeps editable drafts and focus through a rescan %s",
    async (outcome) => {
      const { context, client, request } = createFirstRunContext();
      const { page } = await mountPage(context, {
        client,
        firstRun: false,
        state: { phase: "ready", result: inventory },
      });
      await selectManualProvider(page, "fixture-key");
      const input = page.querySelector<HTMLInputElement>(".model-setup__manual input")!;
      input.value = "synthetic-draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      const pending = createDeferred<SystemAgentSetupDetectResult>();
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.detect") {
          return pending.promise;
        }
        throw new Error("Unexpected request: " + method);
      });
      const scan = [...page.querySelectorAll<HTMLButtonElement>(".model-setup__intro button")].find(
        (button) => button.textContent?.trim() === "Check again",
      )!;
      scan.click();
      await page.updateComplete;
      expect(page.querySelector(".model-setup__loading")).toBeNull();
      expect(page.querySelector(".model-setup__manual input")).toBe(input);
      expect(input.value).toBe("synthetic-draft");
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(scan.disabled).toBe(true);
      scan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
      ).toHaveLength(1);
      if (outcome === "success") {
        pending.resolve(inventory);
      } else {
        pending.reject(new Error("Rescan failed. Try again."));
      }
      await waitForFast(() => expect(scan.disabled).toBe(false));
      expect(page.querySelector(".model-setup__manual input")).toBe(input);
      expect(input.value).toBe("synthetic-draft");
      expect(document.activeElement).toBe(input);
      if (outcome === "failure") {
        expect(page.querySelector('[role="alert"]')?.textContent).toContain("Rescan failed");
      }
    },
  );

  it("clears the old owner's draft and ignores its late rescan", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    const { page } = await mountPage(context, {
      client,
      firstRun: false,
      state: { phase: "ready", result: inventory },
    });
    await selectManualProvider(page, "fixture-key");
    const input = page.querySelector<HTMLInputElement>(".model-setup__manual input")!;
    input.value = "old-owner-draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const pending = createDeferred<SystemAgentSetupDetectResult>();
    request
      .mockImplementationOnce(async () => pending.promise)
      .mockResolvedValue({ ...inventory, workspace: "/new-owner" });
    [...page.querySelectorAll<HTMLButtonElement>(".model-setup__intro button")]
      .find((button) => button.textContent?.trim() === "Check again")!
      .click();
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      hello: {
        ...snapshot.hello,
        auth: { ...snapshot.hello.auth, recoveryScope: "replacement-owner" },
      },
    });
    await waitForFast(() =>
      expect(page.querySelector<HTMLInputElement>(".model-setup__manual input")?.value).toBe(""),
    );
    pending.resolve({ ...inventory, configuredModel: "fixture/stale-model" });
    await page.updateComplete;
    await Promise.resolve();
    expect(page.textContent).not.toContain("stale-model");
    expect(page.querySelector<HTMLInputElement>(".model-setup__manual input")?.value).toBe("");
  });
});
