/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  authButton,
  pageButton,
  mountDetection,
  mockRequests,
  runningStep,
  callsFor,
  authOption,
  configSnapshot,
} from "./model-setup-first-run.test-support.ts";
import {
  createContext,
  detection,
  type TestModelSetupPage,
} from "./test-helpers/page.test-support.ts";

const authStatus: ModelAuthStatusResult = {
  ts: 1,
  providers: [],
  providerCapabilities: [
    {
      provider: "radius",
      apiKeySupported: false,
      quickApiKeySetup: false,
      loginOptions: [
        { ...authOption("radius/radius", "Radius account"), kind: "oauth", brandId: "radius" },
      ],
    },
  ],
};

const setup = {
  ...detection,
  authOptions: [{ ...authOption("setup-only", "Setup-only account"), brandId: "setup-only" }],
};
let fixture: ReturnType<typeof createContext>;
beforeEach(() => {
  fixture = createContext();
});
function configureRequests(handlers: Parameters<typeof mockRequests>[1]) {
  mockRequests(fixture.request, {
    "models.authStatus": () => authStatus,
    "config.get": () => configSnapshot({}, "unchanged"),
    "openclaw.setup.detect": () => setup,
    ...handlers,
  });
}

const signInMethod = (operation: "connect" | "setup") =>
  operation === "connect" ? "models.authLogin" : "openclaw.setup.auth.start";
const labelFor = (operation: "connect" | "setup") =>
  operation === "connect" ? "Radius account" : "Setup-only account";
const modalTitle = (page: ParentNode) => page.querySelector("h2")?.textContent?.trim();
const waiting = "Waiting for approval in your browser…";
const waitForSignIn = (page: ParentNode) =>
  waitForFast(() =>
    expect(page.querySelector(".wizard-step__sign-in")?.textContent).toContain(waiting),
  );

async function startSignIn(page: TestModelSetupPage, operation: "connect" | "setup") {
  if (operation === "setup") {
    authButton(page, "setup-only")!.click();
    return;
  }
  pageButton(page, "[data-models-connect]")!.click();
  await waitForFast(() =>
    expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain("Radius account"),
  );
  pageButton(page, '[data-models-login-provider="radius"]')!.click();
  await page.updateComplete;
  [...page.querySelectorAll<HTMLButtonElement>("[data-models-login-choice] button")]
    .find((button) => button.textContent?.includes("Radius account"))!
    .click();
}

afterEach(() => {
  fixture.runtimeConfig.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  ["connect", "callback"],
  ["setup", "callback"],
  ["connect", "terminal"],
  ["setup", "request"],
] as const)("settles %s OAuth through %s", async (operation, outcome) => {
  const failed = outcome !== "callback";
  if (!failed) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
  const { context, client, request } = fixture;
  vi.spyOn(window, "open").mockReturnValue(null);
  const finish = createDeferred();
  const manual = new AbortController();
  const diagnostic = "Token exchange returned no refresh token.";
  const guidance = "Check the client ID, client secret, and redirect URI.";
  const url = failed
    ? "https://example.invalid/authorize?code=synthetic"
    : "https://example.invalid/authorize";
  const authorization = "Open the authorization URL: " + url;
  let reads = 0;
  let verificationRuns = 0;
  let session: WizardSession | undefined;
  configureRequests({
    [signInMethod(operation)]: () => {
      if (!failed) {
        session = new WizardSession(async (prompter, _signal, active) => {
          await prompter.note("Approve this account in your browser.", "Account access");
          await prompter.openUrl?.(url);
          void prompter
            .text({ message: "Paste the redirect URL", signal: manual.signal })
            .catch(() => {});
          await finish.promise;
          manual.abort();
          if (operation === "setup") {
            verificationRuns += 1;
            active.setModelActivation({ modelRef: "fixture/verified" });
          }
        });
      }
      return { done: false, status: "running" };
    },
    "wizard.next": async (params) => {
      if (!failed) {
        if (!session) {
          throw new Error("Expected registered wizard start");
        }
        const answer = (params as WizardNextParams).answer;
        if (answer) {
          expect(answer.value).toBeUndefined();
          await session.answer(answer.stepId, answer.value);
        }
        return session.next();
      }
      if (++reads <= 2) {
        return runningStep({
          id: "note-" + reads,
          type: "note",
          executor: "client",
          message: reads === 1 ? guidance : authorization,
        });
      }
      if (reads === 3) {
        return runningStep({
          id: "approval",
          type: "progress",
          executor: "gateway",
          message: "Waiting for approval",
          externalUrl: url,
        });
      }
      await finish.promise;
      if (outcome === "request") {
        throw new Error(diagnostic);
      }
      return { done: true, status: "error", error: diagnostic };
    },
    "wizard.cancel": () => {
      session?.cancel();
      return { status: "cancelled" };
    },
  });
  try {
    const { page } = await mountDetection(context, client, setup, false);
    const setupButton = authButton(page, "setup-only")!;
    await startSignIn(page, operation);
    await waitForSignIn(page);
    const modal = page.querySelector("openclaw-modal-dialog")!;
    expect(modalTitle(modal)).toBe(labelFor(operation));
    if (failed) {
      expect(modal.textContent).not.toContain(guidance);
      expect(modal.textContent).not.toContain(url);
    } else {
      expect(verificationRuns).toBe(0);
    }
    finish.resolve();
    if (failed) {
      const expectedError = [diagnostic, guidance, authorization].join("\n\n");
      await waitForFast(() =>
        expect(modal.querySelector(".model-setup-wizard__error-text")?.textContent).toBe(
          expectedError,
        ),
      );
      expect(modalTitle(modal)).toBe(labelFor(operation));
      expect(modal.querySelector(".wizard-step__sign-in")).toBeNull();
      const alert = modal.querySelector("[role=alert]")!;
      expect(alert.textContent).toContain(guidance);
      expect(alert.textContent).toContain(url);
      expect(alert.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')).not.toBeNull();
      expect(modal.querySelector("details")).toBeNull();
      expect(reads).toBe(4);
    } else {
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForFast(
        () =>
          expect(page.textContent).toContain(
            operation === "connect" ? "Provider credentials saved." : "Connection verified",
          ),
        { timeout: 3000 },
      );
      expect(verificationRuns).toBe(operation === "connect" ? 0 : 1);
      expect(page.textContent).not.toContain("Approve this account in your browser.");
      expect(page.textContent).not.toContain(url);
      expect(setupButton.textContent?.trim()).toBe("Set up & verify");
      if (operation === "connect") {
        expect(request).toHaveBeenCalledWith(
          "models.authLogin",
          expect.objectContaining({ authChoice: "radius/radius", agentId: "main" }),
          expect.anything(),
        );
        expect(callsFor(request, "openclaw.setup.auth.start")).toHaveLength(0);
      }
    }
    expect(callsFor(request, "openclaw.setup.activate.start")).toHaveLength(0);
  } finally {
    finish.resolve();
    manual.abort();
    session?.cancel();
    await session?.whenSettled();
  }
});

it.each(["agent", "connection", "cancel"] as const)(
  "discards account inventory after %s changes",
  async (change) => {
    const { context, client, request, snapshot } = fixture;
    const inventory = createDeferred<ModelAuthStatusResult>();
    configureRequests({ "models.authStatus": () => inventory.promise });
    try {
      const { page } = await mountDetection(context, client, setup, false);
      pageButton(page, "[data-models-connect]")!.click();
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "models.authStatus")).toBe(true),
      );
      if (change === "agent") {
        context.settingsAgentSelection.state.selectedId = "other";
      }
      if (change === "connection") {
        snapshot.hello = { ...snapshot.hello };
      }
      if (change === "cancel") {
        pageButton(page, "openclaw-modal-dialog button")!.click();
      } else {
        page.routeData = { firstRun: false };
      }
      await page.updateComplete;
      inventory.resolve(authStatus);
      await inventory.promise;
      await page.updateComplete;
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    } finally {
      inventory.resolve(authStatus);
    }
  },
);
