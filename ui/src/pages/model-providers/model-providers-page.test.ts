/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelsProbeResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import "../../lib/toast-host.ts";
import { choosePickerValue, openPicker, updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createPage,
  mountPage,
  unmountPage,
  createApiKeyProviderData,
  createAuthStatus,
  createEmptyModelProvidersRouteData,
  createHarness,
  drainPageUpdates,
  waitForProviders,
  publishRouteData,
  requestCount,
  saveKey,
  openApiKeyProvider,
  advanceUsageRetries,
  expandProvider,
  focusDocument,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage agent scope", () => {
  it("settles the final update when the page unmounts", async () => {
    const { context } = createHarness("main");
    const page = createPage(context);
    mountPage(page);
    await page.updateComplete;

    unmountPage(page);

    await expect(page.updateComplete).resolves.toBe(true);
  });

  it("recovers a failed preload provider usage result on the next page activation", async () => {
    const { context, request, snapshot } = createHarness("main");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const page = createPage(context);
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      data: {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        providerUsage: { ok: false as const, error: { kind: "request-failed" as const } },
        updatedAt: Date.now(),
      },
      client: snapshot.client,
      agentId: "main",
    };

    mountPage(page);
    await waitForSolid(() => expect(page.view.props.providerUsageFailed).toBe(true));
    const previousCalls = requestCount(request, "usage.status");

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(requestCount(request, "usage.status")).toBe(previousCalls + 1);
    });
    await waitForSolid(() => expect(page.view.props.providerUsageFailed).toBe(false));
  });

  it("defers failed provider usage recovery while hidden until page activation", async () => {
    const { context, request, snapshot, gatewaySource: source } = createHarness("main");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const originalRequest = request.getMockImplementation()!;
    let providerUnavailable = true;
    request.mockImplementation(async (method: string) => {
      if (method === "usage.status" && providerUnavailable) {
        throw new Error("provider usage unreachable");
      }
      return originalRequest(method);
    });
    const page = appendPage(context);
    await waitForSolid(() => expect(page.view.props.providerUsageFailed).toBe(true));
    providerUnavailable = false;

    source.publish({ ...snapshot, phase: "reconnecting" });
    source.publish({ ...snapshot, phase: "connected" });
    expect(requestCount(request, "usage.status")).toBe(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(requestCount(request, "usage.status")).toBe(2));
    await waitForSolid(() => expect(page.view.props.providerUsageFailed).toBe(false));
  });

  it("opens the Usage page from provider access", async () => {
    const { context } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);

    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "View usage")
      ?.click();

    expect(context.navigate).toHaveBeenCalledExactlyOnceWith("usage");
  });

  it("does not readopt an old route snapshot when only loader pending changes", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    const data = page.view.props.authStatus;
    const reads = request.mock.calls.length;
    const row = page.querySelector("[data-provider-id]");

    page.loaderPending = true;
    await page.updateComplete;
    expect(page.view.props.authStatus).toBe(data);
    expect(page.querySelector(".settings-loading-skeleton")).toBeNull();
    expect(page.querySelector("[data-provider-id]")).toBe(row);

    page.loaderPending = false;
    await page.updateComplete;
    expect(page.view.props.authStatus).toBe(data);
    expect(request.mock.calls).toHaveLength(reads);
  });

  it("keeps direct data visible while a same-client reconnect replaces it", async () => {
    const {
      context,
      deferNextAuthStatus,
      request,
      snapshot,
      gatewaySource: source,
    } = createHarness("main");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const page = appendPage(context);
    await waitForProviders(page);
    await vi.waitFor(() => expect(requestCount(request, "usage.status")).toBe(1));
    await drainPageUpdates(page);
    const previousData = page.view.props.authStatus;
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { agents: { defaults: { model: "openai/replacement-model" } } },
          hash: "replacement-hash",
        };
      }
      return originalRequest(method);
    });
    const release = deferNextAuthStatus();

    source.publish({ ...snapshot, phase: "reconnecting" });
    source.publish({ ...snapshot, phase: "connected" });
    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(2));
    expect(page.view.props.authStatus).toBe(previousData);

    release();
    await waitForSolid(() => expect(page.view.props.authStatus).not.toBe(previousData));
    await waitForSolid(() =>
      expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual({
        agents: { defaults: { model: "openai/replacement-model" } },
      }),
    );
  });

  it.each([
    {
      access: "read-only",
      hello: { auth: { role: "operator", scopes: ["operator.read"] } },
    },
    { access: "missing-auth", hello: null },
    { access: "missing-scopes", hello: { auth: { role: "operator" } } },
  ])("keeps saved account identities out of the $access page", async ({ hello }) => {
    const { context, request, snapshot } = createHarness("main");
    snapshot.hello = hello as typeof snapshot.hello;
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "models.authStatus") {
        return {
          ...createAuthStatus([
            {
              profiles: [{ profileId: "openai:owner@example.com", type: "oauth", status: "ok" }],
            },
          ]),
          providerCapabilities: [],
        };
      }
      return originalRequest(method);
    });

    const page = appendPage(context);
    await waitForSolid(() => expect(page.view.props.authStatus?.providers).toHaveLength(1));
    await expandProvider(page, "openai");

    expect(page.querySelector(".model-providers__profiles")).toBeNull();
    expect(page.renderRoot.textContent).not.toContain("owner@example.com");
    expect(page.querySelector(".model-providers__credentials")?.textContent).toContain(
      "OAuth profiles: 1",
    );
  });

  it.each([
    { selection: "xai/grok", expected: ["xai/grok", "google/gemini-pro", "openai/gpt-5-mini"] },
    { selection: "", expected: [] },
  ])(
    "discloses the fallback chain before selecting '$selection'",
    async ({ selection, expected }) => {
      const { context, request, runtimeConfig } = createHarness("main");
      const model = {
        primary: "openai/gpt-5",
        fallbacks: ["anthropic/claude-sonnet", "google/gemini-pro", "openai/gpt-5-mini"],
      };
      const catalog = {
        models: [
          { id: "gpt-5", name: "GPT-5", provider: "openai", available: true },
          {
            id: "claude-sonnet",
            name: "Claude Sonnet",
            provider: "anthropic",
            available: true,
          },
          { id: "gemini-pro", name: "Gemini Pro", provider: "google", available: true },
          { id: "grok", name: "Grok", provider: "xai", available: true },
          { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai", available: true },
        ],
      };
      const originalRequest = request.getMockImplementation()!;
      request.mockImplementation(async (method: string) => {
        if (method === "config.get") {
          return {
            config: {
              agents: { defaults: { model, thinkingDefault: "low", fastModeDefault: "auto" } },
            },
            hash: "model-defaults",
          };
        }
        return method === "models.list" ? catalog : originalRequest(method);
      });
      const page = appendPage(context);
      await waitForProviders(page);
      runtimeConfig.patch.mockClear();

      await updatePickers(page.renderRoot);
      const fallback = [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find(
        (select) =>
          select.querySelector('[role="listbox"]')?.getAttribute("aria-label") === "Fallback Model",
      );
      expect(fallback).toBeDefined();
      expect(page.querySelector(".model-providers__defaults")?.textContent).toContain(
        "2 more fallbacks after this one",
      );
      await openPicker(fallback!);
      expect(fallback?.textContent).toContain("No fallback model (remove all 3)");
      await choosePickerValue(fallback!, selection);

      await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: {
          agents: {
            defaults: {
              model:
                expected.length > 0
                  ? { primary: "openai/gpt-5", fallbacks: expected }
                  : "openai/gpt-5",
              utilityModel: null,
              thinkingDefault: "low",
              fastModeDefault: "auto",
            },
          },
        },
        note: "Update defaults from Control UI",
        replacePaths: ["agents.defaults.model.fallbacks", "agents.defaults.utilityModel.fallbacks"],
      });
    },
  );

  it("autosaves removal of inherited behavior overrides", async () => {
    const { context, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);

    const groups = page.querySelectorAll(
      '#settings-model-behavior .settings-segmented[role="radiogroup"]',
    );
    expect(groups).toHaveLength(2);
    groups[0]!.querySelector<HTMLInputElement>('.settings-segmented__input[value=""]')!.click();
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          defaults: {
            fastModeDefault: "auto",
            thinkingDefault: null,
            utilityModel: null,
          },
        },
      },
      note: "Update defaults from Control UI",
      replacePaths: ["agents.defaults.model.fallbacks", "agents.defaults.utilityModel.fallbacks"],
    });
  });

  it("keeps invalid explicit thinking and fast values resettable", async () => {
    const { context, runtimeConfig, request } = createHarness("main");
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method === "config.get"
        ? {
            config: { agents: { defaults: { thinkingDefault: 42, fastModeDefault: "bogus" } } },
            hash: "invalid-defaults",
          }
        : originalRequest(method),
    );
    const page = appendPage(context);
    await waitForProviders(page);

    const behavior = page.querySelector("#settings-model-behavior")!;
    const groups = behavior.querySelectorAll('.settings-segmented[role="radiogroup"]');
    expect(
      [...groups].map(
        (group) =>
          group.querySelector<HTMLInputElement>(".settings-segmented__input:checked")?.value,
      ),
    ).toEqual(["", ""]);
    const defaults = behavior.querySelectorAll<HTMLInputElement>(
      '.settings-segmented__input[value=""]',
    );
    expect(defaults).toHaveLength(2);
    defaults[0]?.click();
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
  });

  it("keeps saved-key warnings after providers failure", async () => {
    const { context, runtimeConfig, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method) => {
      if (method === "models.authSetApiKey") {
        return { profileId: "openai:key", warning: "Authentication refresh failed." };
      }
      if (method === "models.authStatus") {
        throw new Error("Provider refresh failed.");
      }
      return originalRequest(method);
    });
    await saveKey(page, "replacement");
    await waitForSolid(() => expect(page.view.props.messages.openai?.kind).toBe("success"));

    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.view.props.keyEditorProvider).toBeNull();
    expect(page.view.props.messages.openai).toEqual({
      kind: "success",
      text: "Secret saved.",
      warning: "Authentication refresh failed. Provider refresh failed.",
    });
    await page.updateComplete;
    expect(page.renderRoot.textContent).toContain(page.view.props.messages.openai?.warning);
  });

  it("removes a provider only after confirmation and reports the Gateway warning", async () => {
    const shell = document.body.appendChild(document.createElement("div"));
    shell.className = "shell";
    const toast = shell.appendChild(document.createElement("openclaw-toast-host"));
    const { context, request, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    publishRouteData(page, createApiKeyProviderData());
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method === "models.authLogout"
        ? { removedProfiles: ["openai:key"], warning: "Authentication refresh failed." }
        : originalRequest(method),
    );
    const row = await expandProvider(page, "openai");
    row.querySelector<HTMLButtonElement>(".provider-row__remove")!.click();
    const modal = await vi.waitFor(() => {
      const dialog = document.body.querySelector<HTMLElement>("openclaw-modal-dialog");
      expect(dialog).not.toBeNull();
      return dialog!;
    });
    expect(modal.textContent).toContain("Remove OpenAI");
    expect(requestCount(request, "models.authLogout")).toBe(0);
    modal.querySelector<HTMLButtonElement>("button.danger")!.click();
    await waitForSolid(() => expect(toast.textContent).toContain("Authentication refresh failed."));
    // The saved API-key profile is a provider-wide sign-out; nothing goes through config.
    expect(request.mock.calls.filter(([method]) => method === "models.authLogout")).toEqual([
      ["models.authLogout", { provider: "openai", agentId: "main" }],
    ]);
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("keeps committed provider-add feedback visible when its refresh fails", async () => {
    const { context, runtimeConfig, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method) => {
      if (method === "config.get") {
        throw new Error("config.get failed after provider add");
      }
      return originalRequest(method);
    });
    await openApiKeyProvider(page, "anthropic");
    page.view.props.onAddProviderKeyChange("new-provider-key");

    await page.updateComplete;
    const save = page.querySelector<HTMLButtonElement>("[data-models-key-dialog] button.primary")!;
    expect(save.disabled).toBe(false);
    save.click();
    expect(runtimeConfig.runExternalMutation).toHaveBeenCalledOnce();
    await runtimeConfig.runExternalMutation.mock.results[0]!.value;
    await drainPageUpdates(page);

    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.view.props.addProviderOpen).toBe(true);
    expect(page.view.props.addProviderKey).toBe("");
    const form = page.querySelector("[data-models-key-dialog]");
    expect(
      [...form!.querySelectorAll('[role="status"]')].map((message) => message.textContent?.trim()),
    ).toEqual(["Provider anthropic added.", "config.get failed after provider add"]);
  });

  it("keeps a newer global-model draft after an agent switch and earlier save", async () => {
    const { settingsAgentSelection, context, notifySelection, runtimeConfig } =
      createHarness("main");
    const gate = deferred();
    const replacementGate = deferred();
    const page = appendPage(context);
    await waitForProviders(page);
    runtimeConfig.ensureLoaded.mockClear();
    runtimeConfig.ensureLoaded.mockImplementationOnce(() => gate.promise);
    page.view.props.onPrimaryChange("openai/gpt-5");
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.view.props.credentialAgentLabel).toBe("Writer"));
    runtimeConfig.ensureLoaded.mockImplementationOnce(() => replacementGate.promise);
    page.view.props.onUtilityChange("openai/gpt-4.1-mini");
    gate.resolve();
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    await drainPageUpdates(page);

    expect(page.view.props.defaultModels).toMatchObject({
      primary: "openai/gpt-5",
      utilityModel: "openai/gpt-4.1-mini",
    });
    expect(page.view.props.messages.defaults).toBeUndefined();
    replacementGate.resolve();
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledTimes(2));
  });

  it("cancels a queued key save when the selected agent changes", async () => {
    const { settingsAgentSelection, context, notifySelection, runtimeConfig, request } =
      createHarness("main");
    const gate = deferred();
    runtimeConfig.beforeExternalDispatch.mockImplementationOnce(() => gate.promise);
    const page = appendPage(context);
    await waitForProviders(page);
    await saveKey(page, "main-agent-key");
    await waitForSolid(() => expect(runtimeConfig.beforeExternalDispatch).toHaveBeenCalledOnce());
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.view.props.credentialAgentLabel).toBe("Writer"));
    page.view.props.onOpenKeyEditor("anthropic");
    page.view.props.onKeyDraftChange("writer-agent-unsaved-key");
    gate.resolve();
    await runtimeConfig.runExternalMutation.mock.results[0]?.value;

    expect(request.mock.calls.map(([method]) => method)).not.toContain("models.authSetApiKey");
    expect(page.view.props.keyEditorProvider).toBe("anthropic");
    expect(page.view.props.keyDraft).toBe("writer-agent-unsaved-key");
    expect(page.view.props.messages.openai).toBeUndefined();
  });

  it("keeps a replacement agent's matching add-provider draft after a saved key response", async () => {
    const { settingsAgentSelection, context, notifySelection, runtimeConfig, request } =
      createHarness("main");
    const gate = deferred<unknown>();
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation((method) =>
      method === "models.authSetApiKey" ? gate.promise : originalRequest(method),
    );
    const page = appendPage(context);
    await waitForProviders(page);
    await openApiKeyProvider(page, "anthropic");
    page.view.props.onAddProviderKeyChange("shared-provider-key");

    await page.updateComplete;
    const save = page.querySelector<HTMLButtonElement>("[data-models-key-dialog] button.primary")!;
    expect(save.disabled).toBe(false);
    save.click();
    expect(runtimeConfig.runExternalMutation).toHaveBeenCalledOnce();
    const adding = runtimeConfig.runExternalMutation.mock.results[0]!.value;
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("models.authSetApiKey", {
        provider: "anthropic",
        agentId: "main",
        apiKey: "shared-provider-key",
      }),
    );
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.view.props.credentialAgentLabel).toBe("Writer"));
    await openApiKeyProvider(page, "anthropic");
    page.view.props.onAddProviderKeyChange("shared-provider-key");
    gate.resolve({ profileId: "anthropic:manual-api-key" });
    await adding;
    await drainPageUpdates(page);

    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.view.props.addProviderOpen).toBe(true);
    expect(page.view.props.addProviderId).toBe("anthropic");
    expect(page.view.props.addProviderKey).toBe("shared-provider-key");
    expect(page.view.props.messages.add).toBeUndefined();
  });

  it("drains a queued profile order after switching agents during an active save", async () => {
    const { settingsAgentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet" && requestCount(request, method) === 1) {
        return firstSave.promise;
      }
      void params;
      return originalRequest(method);
    });

    page.view.props.onProfileOrderChange("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.view.props.credentialAgentLabel).toBe("Writer"));
    await waitForProviders(page);
    page.view.props.onProfileOrderChange("openai", "openai", ["openai:one", "openai:two"]);

    firstSave.resolve({});
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(2));
    const orderCalls = request.mock.calls.filter(([method]) => method === "models.authOrderSet");
    expect(orderCalls.at(-1)).toEqual([
      "models.authOrderSet",
      {
        provider: "openai",
        profileIds: ["openai:one", "openai:two"],
        agentId: "writer",
      },
    ]);
  });

  it("restores committed priority and keeps controls available after a rejected save", async () => {
    const { context, request, snapshot } = createHarness("main");
    snapshot.hello = {
      ...snapshot.hello,
      auth: { role: "operator", scopes: ["operator.admin"] },
    } as typeof snapshot.hello;
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    await waitForProviders(page);
    publishRouteData(page, {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      authStatus: createAuthStatus(),
      updatedAt: 1,
    });
    await expandProvider(page, "openai");
    request.mockRejectedValueOnce(new Error("Priority could not be saved"));
    page
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await vi.waitFor(() =>
      expect(toast.querySelector('[role="status"]')?.textContent).toContain(
        "Priority could not be saved",
      ),
    );
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.view.props.messages.openai).toBeUndefined();
    expect(toast.querySelector(".app-toast--bottom .app-toast__icon")).not.toBeNull();
    expect(
      [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
        (row) => row.dataset.profileId,
      ),
    ).toEqual(["openai:one", "openai:two"]);
    expect(
      page.querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )?.disabled,
    ).toBe(false);
  });

  it("shows a roster failure without automatically retrying it", async () => {
    const { settingsAgentSelection, context } = createHarness("main");
    settingsAgentSelection.state.selectedId = null;
    settingsAgentSelection.state.scopeId = null;
    context.agents.state.agentsList = null;
    context.agents.state.agentsError = "Agent roster unavailable";

    const page = appendPage(context);
    await page.updateComplete;

    expect(context.agents.ensureList).not.toHaveBeenCalled();
    expect(page.renderRoot.textContent).toContain("Agent roster unavailable");

    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
    expect(context.agents.refreshList).toHaveBeenCalledOnce();
  });

  it("discards stale route data when selection changes during preload", async () => {
    const { context, snapshot, request } = createHarness("writer");
    const staleData = { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: 1 };
    const page = createPage(context);
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      data: staleData,
      client: snapshot.client,
      agentId: "main",
    };
    mountPage(page);

    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "writer" }),
    );
    expect(page.view.props.credentialAgentLabel).toBe("Writer");
    expect(page.view.props.updatedAt).not.toBe(staleData.updatedAt);
  });

  it("probes credentials in the selected agent scope", async () => {
    const { context, request } = createHarness("writer");
    const page = appendPage(context);
    await waitForProviders(page);
    request.mockClear();

    page.view.props.onProbe("openai", ["openai"]);

    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "openai",
        agentId: "writer",
      }),
    );
  });

  it("stops queued provider probes after switching away from and back to the selected agent", async () => {
    const { settingsAgentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    request.mockClear();
    const firstProbe = deferred<ModelsProbeResult>();
    request.mockImplementationOnce(() => firstProbe.promise);

    page.view.props.onProbe("anthropic", ["anthropic", "claude-cli"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "anthropic",
        agentId: "main",
      }),
    );
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.view.props.credentialAgentLabel).toBe("Writer"));
    settingsAgentSelection.state.selectedId = "main";
    settingsAgentSelection.state.scopeId = "main";
    notifySelection();
    await vi.waitFor(() => expect(page.view.props.credentialAgentLabel).toBe("Main"));
    firstProbe.resolve({ provider: "anthropic", status: "ok", results: [] });
    await drainPageUpdates(page);

    expect(request.mock.calls.filter(([method]) => method === "models.probe")).toHaveLength(1);
    expect(page.view.props.probeResults).toEqual({});
    expect(page.view.props.busy).toEqual({});
  });
});

describe("ModelProvidersPage usage convergence", () => {
  it("keeps account quotas during config saves and refreshes them from the page", async () => {
    const { context, request, snapshot, runtimeConfig, notifyRuntimeConfig } =
      createHarness("main");
    snapshot.hello = {
      type: "hello-ok",
      protocol: 3,
      features: { methods: ["config.get", "config.patch", "codex.accountUsage"] },
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
    const original = request.getMockImplementation()!;
    let usedPercent = 10;
    const accountRequests: unknown[] = [];
    request.mockImplementation(async (method, params?: unknown) => {
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            profiles: [
              { profileId: "openai:one", type: "oauth", status: "ok" },
              { profileId: "openai:two", type: "token", status: "static" },
              { profileId: "openai:key", type: "api_key", status: "static" },
            ],
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            profiles: [{ profileId: "anthropic:one", type: "oauth", status: "ok" }],
          },
        ]);
      }
      if (method === "codex.accountUsage") {
        accountRequests.push(params);
        return {
          updatedAt: 1,
          providers: [
            { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent }] },
          ],
        };
      }
      return original(method);
    });
    const page = appendPage(context);
    await waitForProviders(page);
    const openai = await expandProvider(page, "openai");
    const anthropic = await expandProvider(page, "anthropic");
    const limitsText = () =>
      [...openai.querySelectorAll(".model-providers__account-limits")].map(
        (limits) => limits.textContent,
      );
    await vi.waitFor(() =>
      expect(limitsText()).toEqual([
        expect.stringContaining("90% left"),
        expect.stringContaining("90% left"),
      ]),
    );
    expect(accountRequests).toEqual([
      { agentId: "main", profileId: "openai:one" },
      { agentId: "main", profileId: "openai:two" },
    ]);
    expect(
      [...openai.querySelectorAll('.model-providers__account-limits [role="meter"]')].map((meter) =>
        meter.getAttribute("aria-valuenow"),
      ),
    ).toEqual(["90", "90"]);
    expect(
      anthropic.querySelector('[data-profile-id="anthropic:one"] .model-providers__account-limits'),
    ).toBeNull();
    expect(
      openai.querySelector('[data-profile-id="openai:key"] .model-providers__account-limits'),
    ).toBeNull();
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    await page.updateComplete;
    expect(limitsText()).toEqual([
      expect.stringContaining("90% left"),
      expect.stringContaining("90% left"),
    ]);
    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    usedPercent = 90;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
    await vi.waitFor(() =>
      expect(limitsText()).toEqual([
        expect.stringContaining("10% left"),
        expect.stringContaining("10% left"),
      ]),
    );
    expect(accountRequests).toHaveLength(4);
  });

  it("waits for the route loader before starting provider requests, including after reconnect", async () => {
    const harness = createHarness("main");
    const page = createPage(harness.context);
    mountPage(page);
    await page.updateComplete;
    expect(harness.request.mock.calls.filter(([method]) => method !== "config.get")).toEqual([]);

    harness.publishPhase("offline");
    harness.publishPhase("connected");
    await page.updateComplete;
    expect(harness.request.mock.calls.filter(([method]) => method !== "config.get")).toEqual([]);

    page.routeData = {
      gateway: harness.context.gateway,
      gatewaySnapshot: harness.context.gateway.snapshot,
      selectionIntentRevision: harness.context.settingsAgentSelection.intentRevision,
      client: harness.context.gateway.snapshot.client,
      agentId: "main",
      data: { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: Date.now() },
    };
    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(1));
    await drainPageUpdates(page);
    expect(requestCount(harness.request, "models.authStatus")).toBe(0);
    expect(requestCount(harness.request, "usage.status")).toBe(1);
    // Local session usage belongs to the Usage page.
    expect(requestCount(harness.request, "sessions.usage")).toBe(0);
  });

  it.each(["reconnect", "manual refresh"] as const)(
    "restarts an exhausted retry cycle on %s",
    async (trigger) => {
      vi.useFakeTimers();
      focusDocument();
      const harness = createHarness("main");
      harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
      const page = appendPage(harness.context);
      await page.updateComplete;
      await advanceUsageRetries();
      await page.updateComplete;
      expect(page.renderRoot.textContent).toContain("did not finish loading");

      const usageCallsBeforeRestart = harness.request.mock.calls.filter(
        ([method]) => method === "usage.status",
      ).length;
      expect(usageCallsBeforeRestart).toBe(4);

      if (trigger === "manual refresh") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
        await page.updateComplete;
        await advanceUsageRetries();
        expect(requestCount(harness.request, "usage.status")).toBeGreaterThan(
          usageCallsBeforeRestart + 1,
        );
        return;
      }

      harness.publishPhase("offline");
      await page.updateComplete;
      harness.publishPhase("connected");
      await page.updateComplete;
      await vi.advanceTimersByTimeAsync(0);

      expect(
        harness.request.mock.calls.filter(([method]) => method === "usage.status").length,
      ).toBe(5);
    },
  );

  it("replaces a pending pre-disconnect load before it can publish", async () => {
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [] });
    const releaseOldLoad = harness.deferNextAuthStatus();
    const page = appendPage(harness.context);
    await page.updateComplete;

    harness.publishPhase("offline");
    await page.updateComplete;
    const replacementUsage = {
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "replacement", usedPercent: 25 }],
    };
    harness.setUsageStatus({ updatedAt: 2, providers: [replacementUsage] });
    harness.publishPhase("connected");
    await page.updateComplete;

    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === "usage.status").length,
      ).toBe(1),
    );
    releaseOldLoad();
    await vi.waitFor(() =>
      expect(page.view.props.cards.find((card) => card.id === "openai")?.usage).toEqual(
        replacementUsage,
      ),
    );
  });

  it("cancels and replaces provider usage work on forced refresh", async () => {
    const harness = createHarness("main");
    const oldUsage = deferred<unknown>();
    const originalRequest = harness.request.getMockImplementation()!;
    let firstUsageSignal: AbortSignal | undefined;
    const replacementUsage = {
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "replacement", usedPercent: 25 }],
    };
    let usageCall = 0;
    harness.request.mockImplementation(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "usage.status") {
          usageCall += 1;
          if (usageCall === 1) {
            firstUsageSignal = options?.signal;
            return oldUsage.promise;
          }
          return { updatedAt: 2, providers: [replacementUsage] };
        }
        return originalRequest(method);
      },
    );
    const page = appendPage(harness.context);
    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(1));

    const releaseCoreRefresh = harness.deferNextAuthStatus();
    page.view.props.onRefresh();
    expect(firstUsageSignal?.aborted).toBe(true);

    oldUsage.resolve({
      updatedAt: 1,
      providers: [{ ...replacementUsage, windows: [{ label: "stale", usedPercent: 1 }] }],
    });
    await Promise.resolve();
    expect(page.view.props.cards.every((card) => !card.usage)).toBe(true);

    releaseCoreRefresh();
    await drainPageUpdates(page);

    await vi.waitFor(() =>
      expect(page.view.props.cards.find((card) => card.id === "openai")?.usage).toEqual(
        replacementUsage,
      ),
    );
    await drainPageUpdates(page);
    expect(requestCount(harness.request, "usage.status")).toBe(2);
    expect(requestCount(harness.request, "sessions.usage")).toBe(0);
    expect(page.view.props.cards.find((card) => card.id === "openai")?.usage).toEqual(
      replacementUsage,
    );
  });
});

it("finishes loading with a system-only roster and keeps global defaults editable without scoped requests", async () => {
  const { context, request, runtimeConfig } = createHarness("main");
  context.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main", kind: "system" }],
  };
  const selection = createAgentSelectionCapability(
    context.gateway,
    context.agents,
    undefined,
    undefined,
    { requireConfiguredAgent: true },
  );
  Object.assign(context, { settingsAgentSelection: selection });
  const page = appendPage(context);
  try {
    await runtimeConfig.ensureLoaded();
    await page.updateComplete;
    expect(selection.state.selectedId).toBeNull();
    expect(page.querySelector(".settings-loading-skeleton")).toBeNull();
    expect(page.renderRoot.textContent).toContain("No agents");
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);

    const groups = page.querySelectorAll(
      '.model-providers__defaults .settings-segmented[role="radiogroup"]',
    );
    expect(groups).toHaveLength(2);
    const thinkingHigh = groups[0]!.querySelector<HTMLInputElement>(
      '.settings-segmented__input[value="high"]',
    )!;
    expect(thinkingHigh.disabled).toBe(false);
    thinkingHigh.click();
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          defaults: {
            fastModeDefault: "auto",
            thinkingDefault: "high",
            utilityModel: null,
          },
        },
      },
      note: "Update defaults from Control UI",
      replacePaths: ["agents.defaults.model.fallbacks", "agents.defaults.utilityModel.fallbacks"],
    });
    expect(request.mock.calls.some(([method]) => method.startsWith("models."))).toBe(false);
  } finally {
    unmountPage(page);
    selection.dispose();
  }
});

it("applies provider navigation without replacing an edited search during revalidation", async () => {
  const { context } = createHarness("writer");
  const page = appendPage(context);
  const routeData = { ...createEmptyModelProvidersRouteData(context), provider: "openai" };
  page.routeData = routeData;
  const search = () => page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  await waitForSolid(() => expect(search()?.value).toBe("openai"));

  search().value = "anthropic";
  search().dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  // Route revalidation can publish its pending state before new route data arrives.
  Object.assign(page, { loaderPending: true });
  await page.updateComplete;
  Object.assign(page, { loaderPending: false });
  await waitForSolid(() => expect(search()?.value).toBe("anthropic"));
  page.routeData = { ...routeData };
  await waitForSolid(() => expect(search()?.value).toBe("anthropic"));

  page.routeData = { ...routeData, provider: "minimax-portal" };
  await waitForSolid(() => expect(search()?.value).toBe("minimax"));
  page.routeData = { ...routeData, provider: "" };
  await waitForSolid(() => expect(search()?.value).toBe(""));
});
