/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  waitForText,
  runningStep,
  pageButton,
  authButton,
  activated,
  authOption,
  mountDetection,
  createFirstRunContext,
  configSnapshot,
  candidate,
  callsFor,
  mockRequests,
} from "./model-setup-first-run.test-support.ts";
import { createContext, detection, customIconUrl } from "./test-helpers/page.test-support.ts";
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
        return {
          ...detection,
          configuredModel: "llama-cpp/persisted-before-verification",
          setupComplete: true,
        };
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
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        order.push(method);
        return configSnapshot(config, hash);
      }
      if (method === "config.set") {
        order.push(method);
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { config, hash };
      }
      if (method === "openclaw.setup.activate.start") {
        order.push(method);
        config = { ...config, configuredModel: "openai/gpt-5" };
        hash = "hash-3";
        return activated("openai/gpt-5");
      }
      throw new Error(`Unexpected method ${method}`);
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
      "config.get": () => configSnapshot(),
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
        return configSnapshot();
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
        return {};
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "provider/model", setupComplete: true };
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
    await Promise.resolve();
    expect(order).not.toContain("competing-mutation");

    releaseProgress?.({ done: true, status: "done" });
    await competingMutation;
    expect(order.indexOf("competing-mutation")).toBeGreaterThan(order.indexOf("config.get"));
    runtimeConfig.dispose();
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
      gatewayRestartRequired: true,
    };
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "warning-auth", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done", modelActivation };
      }
      throw new Error(`Unexpected method ${method}`);
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
