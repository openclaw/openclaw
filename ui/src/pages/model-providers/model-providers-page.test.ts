/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelsProbeResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DefaultModelSelection } from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createApiKeyProviderData,
  createAuthStatus,
  createEmptyModelProvidersRouteData,
  createHarness,
  drainPageUpdates,
  waitForProviders,
  requestCount,
  saveKey,
  type ModelProvidersPageTestElement,
  advanceUsageRetries,
  focusDocument,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage agent scope", () => {
  it("recovers a failed preload provider usage result on the next page activation", async () => {
    const { context, request, snapshot } = createHarness("main");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const page = document.createElement(
      "openclaw-model-providers-page",
    ) as ModelProvidersPageTestElement;
    page.context = context;
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

    document.body.append(page);
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: false }));
    const previousCalls = requestCount(request, "usage.status");

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(requestCount(request, "usage.status")).toBe(previousCalls + 1);
    });
    await waitForFast(() =>
      expect(page.data?.providerUsage).toEqual({
        ok: true,
        value: { updatedAt: 1, providers: [] },
      }),
    );
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
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: false }));
    providerUnavailable = false;

    source.publish({ ...snapshot, phase: "reconnecting" });
    source.publish({ ...snapshot, phase: "connected" });
    expect(requestCount(request, "usage.status")).toBe(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(requestCount(request, "usage.status")).toBe(2));
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
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
    await waitForFast(() => expect(page.data?.providerUsage).toMatchObject({ ok: true }));
    const previousData = page.data;
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
    expect(page.data).toBe(previousData);

    release();
    await waitForFast(() => expect(page.data).not.toBe(previousData));
    await waitForFast(() =>
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
    await waitForFast(() => expect(page.data?.authStatus?.providers).toHaveLength(1));
    await page.updateComplete;

    expect(page.querySelector(".model-providers__profiles")).toBeNull();
    expect(page.textContent).not.toContain("owner@example.com");
    expect(page.querySelector(".model-providers__credentials")?.textContent).toContain(
      "OAuth profiles: 1",
    );
  });

  it("preserves trailing fallbacks when replacing the visible fallback", async () => {
    const { context, request, runtimeConfig } = createHarness("main");
    const model = {
      primary: "openai/gpt-5",
      fallbacks: ["anthropic/claude-sonnet", "google/gemini-pro"],
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

    await updatePickers(page);
    const fallback = [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find(
      (select) =>
        select.querySelector('[role="listbox"]')?.getAttribute("aria-label") === "Fallback Model",
    );
    expect(fallback).toBeDefined();
    await choosePickerValue(fallback!, "xai/grok");

    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5",
              fallbacks: ["xai/grok", "google/gemini-pro"],
            },
            utilityModel: null,
            thinkingDefault: "low",
            fastModeDefault: "auto",
          },
        },
      },
      note: "Update defaults from Control UI",
      replacePaths: ["agents.defaults.model.fallbacks"],
    });
  });

  it("autosaves removal of inherited behavior overrides", async () => {
    const { context, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);

    const groups = page.querySelectorAll<HTMLElement & { value: string }>(
      "#settings-model-behavior wa-radio-group",
    );
    expect(groups).toHaveLength(2);
    groups[0]!.value = "";
    groups[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
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
      replacePaths: ["agents.defaults.model.fallbacks"],
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
    const groups = behavior.querySelectorAll<HTMLElement & { value: string }>("wa-radio-group");
    expect([...groups].map((group) => group.value)).toEqual(["", ""]);
    const defaults = behavior.querySelectorAll<HTMLElement>('wa-radio[value=""]');
    expect(defaults).toHaveLength(2);
    defaults[0]?.click();
    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
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
    await waitForFast(() => expect(page.messages.openai?.kind).toBe("success"));

    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.keyEditorProvider).toBeNull();
    expect(page.messages.openai).toEqual({
      kind: "success",
      text: "Secret saved.",
      warning: "Authentication refresh failed. Provider refresh failed.",
    });
    await page.updateComplete;
    expect(page.textContent).toContain(page.messages.openai?.warning);
  });

  it("removes stored API keys through the rendered action and retains its warning", async () => {
    const { context, request, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    page.data = createApiKeyProviderData();
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method === "models.authLogout"
        ? { removedProfiles: ["openai:key"], warning: "Authentication refresh failed." }
        : originalRequest(method),
    );
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".model-providers__card-actions .danger")!.click();
    await waitForFast(() => expect(page.messages.openai?.kind).toBe("success"));
    expect(request).toHaveBeenCalledWith("models.authLogout", {
      provider: "openai",
      agentId: "main",
      credentialType: "api_key",
    });
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.messages.openai).toMatchObject({
      text: "Saved API keys removed.",
      warning: "Authentication refresh failed.",
    });
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
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "new-provider-key";

    await page.updateComplete;
    const save = page.querySelector<HTMLButtonElement>("[data-models-key-dialog] button.primary")!;
    expect(save.disabled).toBe(false);
    save.click();
    expect(runtimeConfig.runExternalMutation).toHaveBeenCalledOnce();
    await runtimeConfig.runExternalMutation.mock.results[0]!.value;
    await drainPageUpdates(page);

    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.addProviderOpen).toBe(true);
    expect(page.addProviderKey).toBe("");
    const form = page.querySelector("[data-models-key-dialog]");
    expect(
      [...form!.querySelectorAll('[role="status"]')].map((message) => message.textContent?.trim()),
    ).toEqual(["Provider anthropic added.", "config.get failed after provider add"]);
  });

  it("keeps a newer global-model draft after an agent switch and earlier save", async () => {
    const { settingsAgentSelection, context, notifySelection, runtimeConfig } =
      createHarness("main");
    const gate = deferred();
    const page = appendPage(context);
    await waitForProviders(page);
    runtimeConfig.ensureLoaded.mockClear();
    runtimeConfig.ensureLoaded.mockImplementationOnce(async () => gate.promise);
    const selection: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.defaultsDraft = selection;

    const saving = page.saveDefaults();
    await vi.waitFor(() => expect(runtimeConfig.ensureLoaded).toHaveBeenCalledOnce());
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    const replacement = { ...selection, utilityModel: "openai/gpt-4.1-mini" };
    page.defaultsDraft = replacement;
    gate.resolve();
    await saving;

    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    expect(page.defaultsDraft).toBe(replacement);
    expect(page.messages.defaults).toBeUndefined();
  });

  it("cancels a queued key save when the selected agent changes", async () => {
    const { settingsAgentSelection, context, notifySelection, runtimeConfig, request } =
      createHarness("main");
    const gate = deferred();
    runtimeConfig.beforeExternalDispatch.mockImplementationOnce(() => gate.promise);
    const page = appendPage(context);
    await waitForProviders(page);
    await saveKey(page, "main-agent-key");
    await waitForFast(() => expect(runtimeConfig.beforeExternalDispatch).toHaveBeenCalledOnce());
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    page.keyEditorProvider = "anthropic";
    page.keyDraft = "writer-agent-unsaved-key";
    gate.resolve();
    await runtimeConfig.runExternalMutation.mock.results[0]?.value;

    expect(request.mock.calls.map(([method]) => method)).not.toContain("models.authSetApiKey");
    expect(page.keyEditorProvider).toBe("anthropic");
    expect(page.keyDraft).toBe("writer-agent-unsaved-key");
    expect(page.messages.openai).toBeUndefined();
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
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "shared-provider-key";

    await page.updateComplete;
    const save = page.querySelector<HTMLButtonElement>("[data-models-key-dialog] button.primary")!;
    expect(save.disabled).toBe(false);
    save.click();
    expect(runtimeConfig.runExternalMutation).toHaveBeenCalledOnce();
    const adding = runtimeConfig.runExternalMutation.mock.results[0]!.value;
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("models.authSetApiKey", {
        provider: "anthropic",
        agentId: "main",
        apiKey: "shared-provider-key",
      }),
    );
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "shared-provider-key";
    gate.resolve({ profileId: "anthropic:manual-api-key" });
    await adding;
    await drainPageUpdates(page);

    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(page.addProviderOpen).toBe(true);
    expect(page.addProviderId).toBe("anthropic");
    expect(page.addProviderKey).toBe("shared-provider-key");
    expect(page.messages.add).toBeUndefined();
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

    page.profileActions.setOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    await waitForProviders(page);
    page.profileActions.setOrder("openai", "openai", ["openai:one", "openai:two"]);

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
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      authStatus: createAuthStatus(),
      updatedAt: 1,
    };
    page.requestUpdate();
    await page.updateComplete;
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
    expect(page.messages.openai).toBeUndefined();
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

  it("ignores logout completion when route data changes the selected agent", async () => {
    const { settingsAgentSelection, context, request, snapshot } = createHarness("main");
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    await waitForProviders(page);
    request.mockClear();
    const firstLogout = deferred<unknown>();
    request.mockImplementationOnce(async () => firstLogout.promise);

    const loggingOut = page.profileActions.logout("openai", {
      provider: "openai",
      profileIds: ["openai:first"],
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const defaultsDraft: DefaultModelSelection = {
      primary: "openai/gpt-5",
      fallbacks: [],
      utilityModel: null,
    };
    page.keyEditorProvider = "openai";
    page.keyDraft = "synthetic-route-agent-key";
    page.addProviderOpen = true;
    page.addProviderId = "anthropic";
    page.addProviderKey = "synthetic-route-provider-key";
    page.defaultsDraft = defaultsDraft;
    page.messages = { openai: { kind: "error", text: "Previous agent failure" } };
    page.probeResults = {
      openai: { provider: "openai", status: "ok", results: [] },
    };
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      data: { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: 1 },
      client: snapshot.client,
      agentId: "writer",
    };
    await page.updateComplete;
    expect(page.selectedAgentId).toBe("writer");
    expect(page.busy).toEqual({});
    expect(page.messages).toEqual({});
    expect(page.probeResults).toEqual({});
    expect(page.keyEditorProvider).toBeNull();
    expect(page.keyDraft).toBe("");
    expect(page.addProviderOpen).toBe(false);
    expect(page.addProviderId).toBe("");
    expect(page.addProviderKey).toBe("");
    expect(page.defaultsDraft).toBe(defaultsDraft);
    firstLogout.resolve({});
    await loggingOut;

    expect(request.mock.calls.filter(([method]) => method === "models.authLogout")).toHaveLength(1);
    await toast.updateComplete;
    expect(toast.querySelector('[role="status"]')).toBeNull();
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
    expect(page.textContent).toContain("Agent roster unavailable");

    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
    expect(context.agents.refreshList).toHaveBeenCalledOnce();
  });

  it("discards stale route data when selection changes during preload", async () => {
    const { context, snapshot, request } = createHarness("writer");
    const staleData = { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: 1 };
    const page = document.createElement(
      "openclaw-model-providers-page",
    ) as ModelProvidersPageTestElement;
    page.context = context;
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      data: staleData,
      client: snapshot.client,
      agentId: "main",
    };
    document.body.append(page);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "writer" }),
    );
    expect(page.selectedAgentId).toBe("writer");
    expect(page.data).not.toBe(staleData);
  });

  it("probes credentials in the selected agent scope", async () => {
    const { context, request } = createHarness("writer");
    const page = appendPage(context);
    await waitForProviders(page);
    request.mockClear();

    await page.profileActions.probe("openai", ["openai"]);

    expect(request).toHaveBeenCalledWith("models.probe", {
      provider: "openai",
      agentId: "writer",
    });
  });

  it("stops queued provider probes after switching away from and back to the selected agent", async () => {
    const { settingsAgentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    request.mockClear();
    const firstProbe = deferred<ModelsProbeResult>();
    request.mockImplementationOnce(() => firstProbe.promise);

    const probing = page.profileActions.probe("anthropic", ["anthropic", "claude-cli"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "anthropic",
        agentId: "main",
      }),
    );
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    settingsAgentSelection.state.selectedId = "main";
    settingsAgentSelection.state.scopeId = "main";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("main"));
    firstProbe.resolve({ provider: "anthropic", status: "ok", results: [] });
    await probing;

    expect(request.mock.calls.filter(([method]) => method === "models.probe")).toHaveLength(1);
    expect(page.probeResults).toEqual({});
    expect(page.busy).toEqual({});
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
    await vi.waitFor(() => expect(page.textContent).toContain("90% left"));
    expect(accountRequests).toEqual([
      { agentId: "main", profileId: "openai:one" },
      { agentId: "main", profileId: "openai:two" },
    ]);
    expect(
      page.querySelector('[data-profile-id="anthropic:one"] openclaw-model-account-usage'),
    ).toBeNull();
    expect(
      page.querySelector('[data-profile-id="openai:key"] openclaw-model-account-usage'),
    ).toBeNull();
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    await page.updateComplete;
    expect(page.textContent).toContain("90% left");
    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    usedPercent = 90;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("10% left"));
  });

  it("waits for the route loader before starting provider requests, including after reconnect", async () => {
    const harness = createHarness("main");
    const page = document.createElement(
      "openclaw-model-providers-page",
    ) as ModelProvidersPageTestElement;
    page.context = harness.context;
    document.body.append(page);
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
    await vi.waitFor(() => expect(page.data?.costByProvider).toEqual([]));
    expect(requestCount(harness.request, "models.authStatus")).toBe(0);
    expect(requestCount(harness.request, "usage.status")).toBe(1);
    expect(requestCount(harness.request, "sessions.usage")).toBe(1);
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
      expect(page.textContent).toContain("did not finish loading");

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

  it("retries incomplete usage without restarting pending cost", async () => {
    vi.useFakeTimers();
    focusDocument();
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [], refreshing: true });
    const pendingCost = deferred<unknown>();
    const originalRequest = harness.request.getMockImplementation()!;
    let costSignal: AbortSignal | undefined;
    harness.request.mockImplementation(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "sessions.usage") {
          costSignal = options?.signal;
          return pendingCost.promise;
        }
        return originalRequest(method);
      },
    );

    const page = appendPage(harness.context);
    await page.updateComplete;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requestCount(harness.request, "usage.status")).toBeGreaterThan(1);
    expect(requestCount(harness.request, "sessions.usage")).toBe(1);
    expect(costSignal?.aborted).toBe(false);

    pendingCost.resolve({ aggregates: { byProvider: [] } });
    await vi.waitFor(() => expect(page.data?.costByProvider).toEqual([]));
  });

  it("replaces a pending pre-disconnect load before it can publish", async () => {
    const harness = createHarness("main");
    harness.setUsageStatus({ updatedAt: 1, providers: [] });
    const releaseOldLoad = harness.deferNextAuthStatus();
    const page = appendPage(harness.context);
    await page.updateComplete;

    harness.publishPhase("offline");
    await page.updateComplete;
    harness.setUsageStatus({ updatedAt: 2, providers: [] });
    harness.publishPhase("connected");
    await page.updateComplete;

    await vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === "usage.status").length,
      ).toBe(1),
    );
    releaseOldLoad();
    await vi.waitFor(() =>
      expect(page.data?.providerUsage).toMatchObject({
        ok: true,
        value: { updatedAt: 2 },
      }),
    );
  });

  it("cancels and replaces supplemental work on forced refresh", async () => {
    const harness = createHarness("main");
    const oldUsage = deferred<unknown>();
    const oldCost = deferred<unknown>();
    const originalRequest = harness.request.getMockImplementation()!;
    let firstUsageSignal: AbortSignal | undefined;
    let firstCostSignal: AbortSignal | undefined;
    let usageCall = 0;
    let costCall = 0;
    harness.request.mockImplementation(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "sessions.usage") {
          costCall += 1;
          if (costCall === 1) {
            firstCostSignal = options?.signal;
            return oldCost.promise;
          }
          return originalRequest(method);
        }
        if (method === "usage.status") {
          usageCall += 1;
          if (usageCall === 1) {
            firstUsageSignal = options?.signal;
            return oldUsage.promise;
          }
          return { updatedAt: 2, providers: [] };
        }
        return originalRequest(method);
      },
    );
    const page = appendPage(harness.context);
    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(1));
    await vi.waitFor(() => expect(requestCount(harness.request, "sessions.usage")).toBe(1));

    const releaseCoreRefresh = harness.deferNextAuthStatus();
    const refresh = page.refresh("forced");
    expect(firstUsageSignal?.aborted).toBe(true);
    expect(firstCostSignal?.aborted).toBe(true);

    oldUsage.resolve({ updatedAt: 1, providers: [] });
    oldCost.resolve({
      aggregates: { byProvider: [{ provider: "stale", totals: { totalCost: 1 } }] },
    });
    await Promise.resolve();
    expect(page.data?.providerUsage).toBeNull();
    expect(page.data?.costByProvider).toBeNull();

    releaseCoreRefresh();
    await refresh;

    await vi.waitFor(() => expect(requestCount(harness.request, "usage.status")).toBe(2));
    await vi.waitFor(() => expect(requestCount(harness.request, "sessions.usage")).toBe(2));
    await vi.waitFor(() =>
      expect(page.data?.providerUsage).toMatchObject({ ok: true, value: { updatedAt: 2 } }),
    );
    await vi.waitFor(() => expect(page.data?.costByProvider).toEqual([]));

    expect(requestCount(harness.request, "usage.status")).toBe(2);
    expect(requestCount(harness.request, "sessions.usage")).toBe(2);
    expect(page.data?.providerUsage).toMatchObject({ ok: true, value: { updatedAt: 2 } });
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
    expect(page.textContent).toContain("No agents");
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);

    const groups = page.querySelectorAll<HTMLElement & { disabled: boolean; value: string }>(
      ".model-providers__defaults wa-radio-group",
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.disabled).toBe(false);
    groups[0]!.value = "high";
    groups[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
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
      replacePaths: ["agents.defaults.model.fallbacks"],
    });
    expect(request.mock.calls.some(([method]) => method.startsWith("models."))).toBe(false);
  } finally {
    page.remove();
    selection.dispose();
  }
});

it("applies provider navigation without replacing an edited search during revalidation", async () => {
  const { context } = createHarness("writer");
  const page = appendPage(context);
  const routeData = { ...createEmptyModelProvidersRouteData(context), provider: "openai" };
  page.routeData = routeData;
  const search = () => page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  await waitForFast(() => expect(search()?.value).toBe("openai"));

  search().value = "anthropic";
  search().dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  // Route revalidation can publish its pending state before new route data arrives.
  Object.assign(page, { loaderPending: true });
  await page.updateComplete;
  Object.assign(page, { loaderPending: false });
  await waitForFast(() => expect(search()?.value).toBe("anthropic"));
  page.routeData = { ...routeData };
  await waitForFast(() => expect(search()?.value).toBe("anthropic"));

  page.routeData = { ...routeData, provider: "minimax-portal" };
  await waitForFast(() => expect(search()?.value).toBe("minimax"));
  page.routeData = { ...routeData, provider: "" };
  await waitForFast(() => expect(search()?.value).toBe(""));
});
