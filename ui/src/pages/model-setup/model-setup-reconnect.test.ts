/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activated,
  running,
  callsFor,
  authButton,
  waitForElement,
  waitForText,
  createFirstRunContext,
  detection as emptyDetection,
  runningStep,
} from "./model-setup-first-run.test-support.ts";
import type { TestModelSetupPage } from "./test-helpers/page.test-support.ts";
import {
  createPage,
  mountModelSetupPage,
  unmountModelSetupPage,
} from "./test-helpers/solid-page.test-support.tsx";

const detection: SystemAgentSetupDetectResult = {
  ...emptyDetection,
  authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
};

function createFixture() {
  const {
    context: originalContext,
    request,
    snapshot,
    publishGatewaySnapshot,
  } = createFirstRunContext();
  originalContext.runtimeConfig.dispose();
  const context = {
    ...originalContext,
    basePath: "",
    runtimeConfig: createRuntimeConfigCapability(originalContext.gateway),
  };
  context.gateway.connection.gatewayUrl = "ws://localhost";
  context.gateway.connection.token = "";
  const connectedSnapshot = {
    ...snapshot,
    hello: {
      ...snapshot.hello,
      features: { methods: ["openclaw.setup.detect", "openclaw.setup.verify"] },
    },
  };
  publishGatewaySnapshot(connectedSnapshot);
  return {
    context,
    request,
    switchGateway: () => {
      // Another Gateway (or credential) is a new connection revision and owner.
      Object.assign(context.gateway, {
        connectionRevision: context.gateway.connectionRevision + 1,
      });
      publishGatewaySnapshot({
        ...connectedSnapshot,
        hello: {
          ...connectedSnapshot.hello,
          auth: { ...connectedSnapshot.hello.auth, recoveryScope: "replacement-setup-owner" },
        },
      });
    },
    setGatewayPhase: (phase: "connected" | "reconnecting") =>
      publishGatewaySnapshot({
        ...connectedSnapshot,
        phase,
        hello: phase === "connected" ? { ...connectedSnapshot.hello } : null,
      }),
    detectCalls: () => callsFor(request, "openclaw.setup.detect"),
  };
}

async function mountPage(context: ApplicationContext, visit = true): Promise<TestModelSetupPage> {
  const provider = createApplicationContextProvider(context);
  const page = createPage(context);
  if (visit) {
    page.routeData = { firstRun: false };
  }
  provider.append(page);
  document.body.append(provider);
  mountModelSetupPage(page);
  await page.updateComplete;
  return page;
}

const selectedModelDetail = (page: TestModelSetupPage) =>
  page.querySelector(".model-setup__current-copy > .muted")?.textContent?.trim();

describe("ModelSetupPage detection ownership", () => {
  let fixture: ReturnType<typeof createFixture>;
  beforeEach(async () => {
    fixture = createFixture();
    await i18n.setLocale("en");
  });

  afterEach(() => {
    fixture.context.runtimeConfig.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each(["route", "gateway"] as const)(
    "waits for %s readiness before detection",
    async (ready) => {
      const warnings = vi.spyOn(console, "warn");
      const { context, request, setGatewayPhase, detectCalls } = fixture;
      request.mockImplementation(async (method) =>
        method === "openclaw.setup.detect" ? detection : {},
      );
      if (ready === "gateway") {
        setGatewayPhase("reconnecting");
      }
      const page = await mountPage(context, ready !== "route");
      expect(request).not.toHaveBeenCalled();
      expect(warnings.mock.calls.flat().join("\n")).not.toContain("[STRICT_READ_UNTRACKED]");
      if (ready === "gateway") {
        expect(authButton(page, "provider-auth")).toBeNull();
        setGatewayPhase("connected");
      } else {
        page.routeData = { firstRun: false };
      }
      await vi.waitFor(() => {
        expect(detectCalls()).toHaveLength(1);
        expect(authButton(page, "provider-auth")).not.toBeNull();
        if (ready === "route") {
          expect(request).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it("rejects stale detection after reattach", async () => {
    const { context, request } = fixture;
    const stale = createDeferred<SystemAgentSetupDetectResult>();
    let signal: AbortSignal | undefined;
    request.mockImplementationOnce(async (_method, _params, options) => {
      signal = options?.signal;
      return stale.promise;
    });
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect"
        ? { ...detection, configuredModel: "provider/current-model", setupComplete: true }
        : {},
    );
    const page = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(page.querySelector(".model-setup__loading")).not.toBeNull();
    const provider = page.parentElement!;
    unmountModelSetupPage(page);
    page.remove();
    page.routeData = { firstRun: false };
    provider.append(page);
    mountModelSetupPage(page);
    await vi.waitFor(() => expect(selectedModelDetail(page)).toBe("current-model"));
    expect(signal?.aborted).toBe(true);
    stale.resolve({ ...detection, configuredModel: "provider/stale-model", setupComplete: true });
    await vi.waitFor(() => expect(request.mock.settledResults[0]?.type).toBe("fulfilled"));
    await page.updateComplete;
    expect(selectedModelDetail(page)).toBe("current-model");
  });

  it("replaces failed detection with loading while the agent roster is pending", async () => {
    const { context, request, detectCalls } = fixture;
    const agents = createAgentCapability(context.gateway);
    const retry = createDeferred<SystemAgentSetupDetectResult>();
    request.mockRejectedValueOnce(new Error("Detection failed before roster refresh."));
    request.mockImplementation(() => retry.promise);
    try {
      const page = await mountPage({ ...context, agents });
      await waitForText(page, "Detection failed before roster refresh.");

      context.settingsAgentSelection.state.selectedId = null;
      page.routeData = { firstRun: false };
      await vi.waitFor(() => {
        expect(page.querySelector(".model-setup__loading")).not.toBeNull();
        expect(page.querySelector('[role="alert"]')).toBeNull();
      });
      expect(detectCalls()).toHaveLength(1);

      context.settingsAgentSelection.state.selectedId = "main";
      page.routeData = { firstRun: false };
      await vi.waitFor(() => expect(detectCalls()).toHaveLength(2));
      expect(page.querySelector(".model-setup__loading")).not.toBeNull();
      retry.resolve(detection);
      await waitForElement(page, '[data-auth-choice="provider-auth"]');
      expect(page.querySelector('[role="alert"]')).toBeNull();
    } finally {
      retry.resolve(detection);
      agents.dispose();
    }
  });

  it("resumes the provider wizard after reconnect", async () => {
    const { context, request, setGatewayPhase } = fixture;
    let oldWizardSignal: AbortSignal | undefined;
    let nextCalls = 0;
    request.mockImplementation(async (method, _params, options) => {
      if (method === "openclaw.setup.auth.start") {
        return running;
      }
      if (method === "wizard.next") {
        nextCalls += 1;
        if (nextCalls > 1) {
          return runningStep({
            id: "provider-key",
            type: "text",
            message: "Enter the selected provider key",
            sensitive: true,
          });
        }
        oldWizardSignal = options?.signal;
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      if (method === "config.get") {
        return sourceConfigSnapshot();
      }
      return method === "openclaw.setup.detect" ? detection : {};
    });
    const page = await mountPage(context);
    await waitForElement(page, '[data-auth-choice="provider-auth"]');
    authButton(page, "provider-auth")!.click();
    await vi.waitFor(() => expect(oldWizardSignal).toBeInstanceOf(AbortSignal));
    const start = request.mock.calls.find(([method]) => method === "openclaw.setup.auth.start")!;

    setGatewayPhase("reconnecting");
    setGatewayPhase("connected");
    await waitForText(page, "Enter the selected provider key");
    await vi.waitFor(() => {
      expect(page.querySelector<HTMLInputElement>("#model-setup-wizard-text-input")?.disabled).toBe(
        false,
      );
    });
    expect(oldWizardSignal?.aborted).toBe(true);
    expect(callsFor(request, "openclaw.setup.auth.start")).toHaveLength(1);
    expect(callsFor(request, "wizard.cancel")).toHaveLength(0);
    expect(request.mock.calls.findLast(([method]) => method === "wizard.next")?.[1]).toEqual({
      sessionId: (start[1] as { sessionId: string }).sessionId,
    });
  });
});

describe("ModelSetupPage browser sign-in return", () => {
  const url = "https://auth.example.com/authorize?state=fixture";
  let fixture: ReturnType<typeof createFixture>;
  beforeEach(async () => {
    fixture = createFixture();
    await i18n.setLocale("en");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.context.runtimeConfig.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const signInOpenCalls = (open: { mock: { calls: unknown[][] } }) =>
    open.mock.calls.filter(([target]) => target === url);

  async function startSignIn() {
    const page = await mountPage(fixture.context);
    await waitForElement(page, '[data-auth-choice="provider-auth"]');
    authButton(page, "provider-auth")!.click();
    await waitForElement(page, ".wizard-sign-in");
    return page;
  }

  it("continues the same attempt after the window hides, refocuses, and reconnects", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const callback = createDeferred<void>();
    const manual = new AbortController();
    let session: WizardSession | undefined;
    fixture.request.mockImplementation(async (method, params) => {
      if (method === "openclaw.setup.auth.start") {
        session = new WizardSession(async (prompter, _signal, active) => {
          await prompter.openUrl?.(url);
          void prompter
            .text({ message: "Paste the redirect URL", signal: manual.signal })
            .catch(() => {});
          await callback.promise;
          manual.abort();
          active.setModelActivation({ modelRef: "fixture/oauth" });
        });
        return running;
      }
      if (method === "wizard.next") {
        const answer = (params as WizardNextParams).answer;
        if (answer) {
          await session!.answer(answer.stepId, answer.value);
        }
        return session!.next();
      }
      if (method === "config.get") {
        return sourceConfigSnapshot();
      }
      return method === "openclaw.setup.detect" ? detection : {};
    });
    try {
      const page = await startSignIn();
      expect(signInOpenCalls(open)).toHaveLength(1);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      fixture.setGatewayPhase("reconnecting");
      await vi.advanceTimersByTimeAsync(3_000);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      fixture.setGatewayPhase("connected");
      await waitForElement(page, ".wizard-sign-in");

      callback.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForText(page, "Model verified");
      expect(callsFor(fixture.request, "openclaw.setup.auth.start")).toHaveLength(1);
      expect(callsFor(fixture.request, "wizard.cancel")).toHaveLength(0);
      expect(callsFor(fixture.request, "openclaw.setup.activate.start")).toHaveLength(0);
      expect(signInOpenCalls(open)).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      callback.resolve();
      manual.abort();
      session?.cancel();
      await session?.whenSettled();
    }
  });

  it.each(["cancel", "switch"] as const)(
    "ignores a late browser return after %s",
    async (change) => {
      vi.spyOn(window, "open").mockReturnValue(null);
      const late = createDeferred<unknown>();
      let holdNext = false;
      fixture.request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return running;
        }
        if (method === "wizard.next") {
          return holdNext
            ? late.promise
            : runningStep({
                id: "redirect",
                type: "text",
                executor: "client",
                message: "Paste the redirect URL",
                externalUrl: url,
              });
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        if (method === "config.get") {
          return sourceConfigSnapshot();
        }
        return method === "openclaw.setup.detect" ? detection : {};
      });
      const page = await startSignIn();
      holdNext = true;
      await vi.advanceTimersByTimeAsync(1_000);
      // The step read plus one callback poll that is still waiting for its reply.
      const pollCount = callsFor(fixture.request, "wizard.next").length;
      expect(pollCount).toBe(2);

      if (change === "cancel") {
        page.querySelector<HTMLButtonElement>(".model-setup-wizard__close")!.click();
      } else {
        fixture.switchGateway();
      }
      await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
      late.resolve(activated("fixture/previous-account"));
      await vi.advanceTimersByTimeAsync(2_000);
      await page.updateComplete;

      expect(page.textContent).not.toContain("Model verified");
      expect(page.textContent).not.toContain("fixture/previous-account");
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(fixture.context.navigate).not.toHaveBeenCalled();
      expect(callsFor(fixture.request, "wizard.next")).toHaveLength(pollCount);
      expect(callsFor(fixture.request, "openclaw.setup.auth.start")).toHaveLength(1);
      expect(callsFor(fixture.request, "openclaw.setup.activate.start")).toHaveLength(0);
    },
  );
});
