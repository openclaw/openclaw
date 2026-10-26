/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult, ModelAuthStatusResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  configuredDetection,
  waitForText,
  runningStep,
  pageButton,
  authButton,
  activated,
  authOption,
  mountDetection,
  createFirstRunContext,
  candidate,
  callsFor,
  mockRequests,
  answerWizard,
  requestParameters,
} from "./model-setup-first-run.test-support.ts";
import {
  createContext,
  detection,
  customIconUrl,
  type TestModelSetupPage,
} from "./test-helpers/page.test-support.ts";
import {
  createPage,
  mountModelSetupPage,
  unmountModelSetupPage,
} from "./test-helpers/solid-page.test-support.tsx";

const codexCandidate = {
  ...candidate("codex-cli", "openai/gpt-5", true),
  brandId: "openai",
  recommended: true,
} satisfies SystemAgentSetupDetectResult["candidates"][number];

function mountSettings(
  context: ApplicationContext,
  client: GatewayBrowserClient,
  result: Partial<SystemAgentSetupDetectResult> = {},
) {
  return mountDetection(context, client, { ...detection, ...result }, false);
}

describe("ModelSetupPage catalog icons", () => {
  beforeEach(() => i18n.setLocale("en"));

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("redacts initial detection failures and recovers through Retry", async () => {
    const { context, request, runtimeConfig } = createContext();
    request.mockRejectedValueOnce(new Error("OPENAI_API_KEY=sk-1234567890abcdef"));
    request.mockResolvedValue(detection);
    const page = createPage(context);
    page.routeData = { firstRun: false };
    document.body.append(page);
    mountModelSetupPage(page);

    await waitForFast(() => {
      expect(page.textContent).toContain("OPENAI_API_KEY=sk-123...cdef");
      expect(page.textContent).not.toContain("sk-1234567890abcdef");
    });
    [...page.querySelectorAll<HTMLButtonElement>(".model-setup .btn")]
      .find((button) => button.textContent?.trim() === "Retry")
      ?.click();
    await waitForFast(() => {
      expect(page.querySelector('[data-prepare-choice="llama-cpp"]')).not.toBeNull();
      expect(page.querySelector('[role="alert"]')).toBeNull();
    });
    expect(request).toHaveBeenCalledTimes(2);
    runtimeConfig.dispose();
  });

  it("loads unknown wire icons through the authenticated same-origin catalog proxy", async () => {
    const NativeUrl = URL;
    const createObjectURL = vi.fn(() => "blob:acme-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountSettings(context, client, {
      recommendedInstalls: [
        {
          id: "acme",
          label: "Acme",
          hint: "Install the Acme runtime",
          website: "https://example.com/acme",
          icon: customIconUrl,
        },
      ],
    });

    await waitForFast(() => {
      expect(
        page
          .querySelector<HTMLImageElement>(".model-setup__recommendation img")
          ?.getAttribute("src"),
      ).toBe("blob:acme-icon");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(customIconUrl)}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(page.innerHTML).not.toContain(customIconUrl);

    unmountModelSetupPage(page);
    page.remove();
    await page.updateComplete;
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:acme-icon");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps an incomplete provider setup visible instead of claiming success", async () => {
    const { context, client, request } = createContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return configuredDetection("llama-cpp/persisted-before-verification");
      }
      return {};
    });
    const { page } = await mountSettings(context, client, detection);

    pageButton(page, '[data-prepare-choice="llama-cpp"] button')?.click();

    await waitForFast(() => {
      expect(page.textContent).toContain(
        "llama.cpp did not expose a usable local model. Review the setup result, then retry.",
      );
    });
    expect(page.textContent).not.toContain("llama-cpp/persisted-before-verification");
    expect(page.textContent).not.toContain("Connection verified");
    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.activate.start",
      expect.anything(),
      expect.anything(),
    );
  });

  it("config.set flushes a pending config draft before activation review and refreshes afterward", async () => {
    vi.useFakeTimers();
    const { context, client, request, runtimeConfig } = createContext();
    const order: string[] = [];
    let config: Record<string, unknown> = { pending: false };
    let hash = "hash-1";
    mockRequests(request, {
      "config.get": () => {
        order.push("config.get");
        return sourceConfigSnapshot(config, hash);
      },
      "config.set": (params) => {
        order.push("config.set");
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { config, hash };
      },
      "openclaw.setup.activate.start": () => {
        order.push("openclaw.setup.activate.start");
        config = { ...config, configuredModel: "openai/gpt-5" };
        hash = "hash-3";
        return activated("openai/gpt-5");
      },
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    const { page } = await mountSettings(context, client, {
      candidates: [codexCandidate],
    });

    pageButton(page, '[data-candidate-kind="codex-cli"] button')?.click();

    await vi.waitFor(() => {
      expect(order).toEqual(["config.set", "openclaw.setup.activate.start", "config.get"]);
    });
    expect(runtimeConfig.state).toMatchObject({
      configSnapshot: { hash: "hash-3" },
      configForm: { pending: true, configuredModel: "openai/gpt-5" },
    });
    runtimeConfig.dispose();
  });

  it("drops a queued wizard action when setup access changes before dispatch", async () => {
    const { context, client, request, runtimeConfig, snapshot } = createContext();
    const configSet = createDeferred<{ hash: string }>();
    mockRequests(request, {
      "config.get": () => sourceConfigSnapshot(),
      "config.set": () => configSet.promise,
    });
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["pending"], true);
    const { page } = await mountSettings(context, client, {
      authOptions: [authOption("provider-auth")],
    });

    authButton(page, "provider-auth")?.click();
    await vi.waitFor(() => expect(callsFor(request, "config.set")).toHaveLength(1));
    snapshot.hello.auth.scopes = ["operator.read"];
    configSet.resolve({ hash: "hash-2" });

    await waitForText(page, "Model setup request failed.");
    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.auth.start",
      expect.anything(),
      expect.anything(),
    );
    runtimeConfig.dispose();
  });

  it("keeps autonomous gateway progress inside the wizard mutation lane", async () => {
    const { context, client, request, runtimeConfig } = createContext();
    const order: string[] = [];
    let nextCount = 0;
    let releaseProgress: ((value: unknown) => void) | undefined;
    request.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        order.push("config.get");
        return sourceConfigSnapshot();
      }
      order.push(method);
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "wizard-session", done: false, status: "running" };
      }
      if (method === "wizard.next" && nextCount++ === 0) {
        return runningStep({
          id: "download",
          type: "progress",
          message: "Downloading",
          executor: "gateway",
        });
      }
      if (method === "wizard.next") {
        return await new Promise((resolve) => {
          releaseProgress = resolve;
        });
      }
      if (method === "wizard.cancel") {
        return { status: "running" };
      }
      if (method === "openclaw.setup.detect") {
        return configuredDetection("provider/model");
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    const { page } = await mountSettings(context, client, {
      authOptions: [authOption("provider-auth")],
    });
    authButton(page, "provider-auth")?.click();
    await vi.waitFor(() => expect(releaseProgress).toBeTypeOf("function"));

    const competingMutation = runtimeConfig.runExternalMutation(async () => {
      order.push("competing-mutation");
    });
    await Promise.resolve();
    expect(order).not.toContain("competing-mutation");

    pageButton(page, "openclaw-modal-dialog .btn")?.click();
    await page.updateComplete;
    await waitForText(page, "finishing");
    expect(page.querySelector(".wizard-step__progress")).not.toBeNull();
    await Promise.resolve();
    expect(order).not.toContain("competing-mutation");

    releaseProgress?.({ done: true, status: "done" });
    await competingMutation;
    expect(order.indexOf("competing-mutation")).toBeGreaterThan(order.indexOf("config.get"));
    runtimeConfig.dispose();
  });

  it("keeps wizard input busy through reconciliation and retains a rejected draft", async () => {
    const startEntered = createDeferred();
    const releaseStart = createDeferred();
    const initialRefresh = createDeferred();
    const answerRefresh = createDeferred();
    let refreshes = 0;
    const { context, client, request } = createFirstRunContext(undefined, () =>
      ++refreshes === 1 ? initialRefresh.promise : answerRefresh.promise,
    );
    const step = { id: "provider-key", type: "text" as const, message: "Provider key" };
    mockRequests(request, {
      "openclaw.setup.auth.start": async () => {
        startEntered.resolve();
        await releaseStart.promise;
        return { sessionId: "wizard-session", done: false, status: "running" };
      },
      "wizard.next": (params) => ({
        ...runningStep(step),
        ...("answer" in requestParameters(params)
          ? { error: "Try a different provider key." }
          : {}),
      }),
    });
    const { page } = await mountSettings(context, client, {
      authOptions: [authOption("provider-auth")],
    });
    authButton(page, "provider-auth")!.click();
    await startEntered.promise;
    await waitForFast(() =>
      expect(page.querySelector<HTMLDialogElement>("openclaw-modal-dialog dialog")?.open).toBe(
        true,
      ),
    );
    releaseStart.resolve();
    await waitForText(page, "Provider key");
    const input = page.querySelector<HTMLInputElement>("#model-setup-wizard-text-input")!;
    await waitForFast(() => {
      expect(input.disabled).toBe(true);
      expect(page.querySelector<HTMLDialogElement>("openclaw-modal-dialog dialog")?.open).toBe(
        true,
      );
    });
    initialRefresh.resolve();
    await waitForFast(() => expect(input.disabled).toBe(false));

    await answerWizard(page, "draft-key");
    await waitForText(page, "Try a different provider key.");
    expect(page.querySelector("#model-setup-wizard-text-input")).toBe(input);
    expect(input.value).toBe("draft-key");
    expect(input.disabled).toBe(true);
    page
      .querySelector<HTMLFormElement>("openclaw-modal-dialog form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(callsFor(request, "wizard.next")).toHaveLength(2);
    answerRefresh.resolve();
    await waitForFast(() => expect(input.disabled).toBe(false));
    expect(input.value).toBe("draft-key");
  });

  it("does not activate a stale candidate through a replacement connection", async () => {
    const { context: baseContext, client } = createContext();
    const replacementRequest = vi.fn();
    const replacementClient = {
      request: replacementRequest,
    } as unknown as GatewayBrowserClient;
    const context = {
      ...baseContext,
      runtimeConfig: {
        runExternalMutation: vi.fn(async (task) => {
          try {
            return {
              ok: true as const,
              value: await task(replacementClient),
              refresh: { ok: true as const },
            };
          } catch (error) {
            return { ok: false as const, reason: "error" as const, error: String(error) };
          }
        }),
      } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    const { page } = await mountSettings(context, client, {
      candidates: [codexCandidate],
    });

    pageButton(page, '[data-candidate-kind="codex-cli"] button')?.click();

    await waitForFast(() => {
      expect(page.textContent).toContain("Connection changed before model setup continued.");
    });
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("keeps verified provider sign-in visible with restart and config refresh warnings", async () => {
    const refreshError = "config.get failed after model commit";
    const { context, client, request } = createFirstRunContext(refreshError);
    const modelActivation = {
      modelRef: "provider/verified",
      gatewayRestartRequired: true as const,
    };
    mockRequests(request, {
      "openclaw.setup.auth.start": () => ({
        sessionId: "warning-auth",
        done: false,
        status: "running",
      }),
      "wizard.next": () => activated(modelActivation.modelRef, modelActivation),
    });
    const { page } = await mountSettings(context, client, {
      authOptions: [authOption("provider-auth")],
    });
    authButton(page, "provider-auth")?.click();
    await waitForFast(() => {
      expect(page.textContent).toContain("Connection verified");
      const warning = page.querySelector(".model-setup-success__warning")?.textContent;
      for (const expected of ["Gateway restart required.", refreshError]) {
        expect(warning).toContain(expected);
      }
      expect(page.textContent).not.toContain("You can start chatting now.");
      expect(page.querySelector(".model-setup-success .btn.primary")?.textContent?.trim()).toBe(
        "Chat",
      );
    });
  });
});

describe("Model setup account connections", () => {
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
      "config.get": () => sourceConfigSnapshot({}, "unchanged"),
      "openclaw.setup.detect": () => setup,
      ...handlers,
    });
  }

  const signInMethod = (operation: "connect" | "setup") =>
    operation === "connect" ? "models.authLogin" : "openclaw.setup.auth.start";
  const labelFor = (operation: "connect" | "setup") =>
    operation === "connect" ? "Radius account" : "Setup-only account";
  const modalTitle = (page: ParentNode) => page.querySelector("h2")?.textContent?.trim();
  const waitForSignIn = (page: ParentNode, operation: "connect" | "setup") =>
    waitForFast(() =>
      expect(page.querySelector('.wizard-sign-in [role="status"]')?.textContent).toBe(
        "Waiting for " + labelFor(operation) + "…",
      ),
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
      await waitForSignIn(page, operation);
      const modal = page.querySelector("openclaw-modal-dialog")!;
      expect(modal.querySelector(".wizard-sign-in__lead")?.textContent).toContain(
        labelFor(operation) + " is open in a new tab.",
      );
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
        expect(modal.querySelector(".wizard-sign-in")).toBeNull();
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
});
