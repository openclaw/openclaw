/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import {
  callsFor,
  authButton,
  waitForElement,
  waitForText,
  configSnapshot,
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
      const { context, request, setGatewayPhase, detectCalls } = fixture;
      request.mockImplementation(async (method) =>
        method === "openclaw.setup.detect" ? detection : {},
      );
      if (ready === "gateway") {
        setGatewayPhase("reconnecting");
      }
      const page = await mountPage(context, ready !== "route");
      expect(request).not.toHaveBeenCalled();
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
    const { context, request, detectCalls } = fixture;
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
    expect(detectCalls()).toHaveLength(2);
    expect(detectCalls().at(-1)).toEqual([
      "openclaw.setup.detect",
      { agentId: "main" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
    stale.resolve({ ...detection, configuredModel: "provider/stale-model", setupComplete: true });
    await vi.waitFor(() => expect(request.mock.settledResults[0]?.type).toBe("fulfilled"));
    await page.updateComplete;
    expect(selectedModelDetail(page)).toBe("current-model");
  });

  it("resumes the provider wizard after reconnect", async () => {
    const { context, request, setGatewayPhase } = fixture;
    let oldWizardSignal: AbortSignal | undefined;
    let nextCalls = 0;
    request.mockImplementation(async (method, _params, options) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
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
        return configSnapshot();
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
    expect(oldWizardSignal?.aborted).toBe(true);
    expect(callsFor(request, "openclaw.setup.auth.start")).toHaveLength(1);
    expect(callsFor(request, "wizard.cancel")).toHaveLength(0);
    expect(request.mock.calls.findLast(([method]) => method === "wizard.next")?.[1]).toEqual({
      sessionId: (start[1] as { sessionId: string }).sessionId,
    });
  });
});
