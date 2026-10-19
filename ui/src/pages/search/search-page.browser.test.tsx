import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { WebSearchStatusResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SearchPage } from "./search-page.tsx";

const providerPath = ["plugins", "entries", "searxng", "config", "webSearch"];
const ready: WebSearchStatusResult = {
  enabled: true,
  provider: null,
  agentId: "main",
  model: { provider: "example", id: "local", runtime: "pi" },
  route: { kind: "managed", provider: "searxng", label: "SearXNG", testable: true },
  providers: [
    {
      id: "searxng",
      pluginId: "searxng",
      label: "SearXNG",
      hint: "Self-hosted search",
      configured: true,
      installed: true,
      available: true,
      requiresCredential: false,
      credentialSource: "none",
      configPath: providerPath,
    },
  ],
};

async function mount(
  options: {
    result?: WebSearchStatusResult;
    admin?: boolean;
    config?: Record<string, unknown>;
    modelsResponse?: Promise<ModelCatalogResult>;
    waitReady?: boolean;
  } = {},
) {
  let result = options.result ?? ready;
  const requested: Promise<unknown>[] = [];
  const statusRequested = createDeferred();
  let testResponse: Promise<unknown> = Promise.resolve({
    provider: "searxng",
    status: "ok",
    latencyMs: 12,
    results: [
      { title: "Documentation", url: "https://example.com/docs", snippet: "Search result" },
    ],
  });
  const request = createGatewayRequestMock((method) => {
    if (method === "webSearch.status") {
      statusRequested.resolve();
    }
    const response =
      method === "webSearch.status"
        ? Promise.resolve(result)
        : method === "webSearch.test"
          ? testResponse
          : method === "models.list"
            ? (options.modelsResponse ?? Promise.resolve({ models: [] }))
            : method === "plugins.credentials.inspect"
              ? Promise.resolve({ baseHash: "one", credential: { kind: "missing" } })
              : Promise.resolve({});
    requested.push(response);
    return response;
  });
  const client = createTestGatewayClient(request);
  const snapshot = {
    phase: "connected",
    client,
    hello: {
      auth: {
        role: "operator",
        scopes: options.admin === false ? ["operator.read"] : ["operator.admin"],
      },
    },
  } as ApplicationGatewaySnapshot;
  const gateway = createApplicationGateway(snapshot);
  const config = options.config ?? {
    tools: { web: { search: { enabled: true } } },
    plugins: {
      entries: { searxng: { config: { webSearch: { baseUrl: "https://search.example.com" } } } },
    },
  };
  const configState = {
    ...createInitialConfigState(snapshot),
    configForm: config,
    configSnapshot: { config, hash: "one", valid: true, issues: [] },
  };
  const runtimeListeners = new Set<() => void>();
  const runtime = {
    state: configState,
    canPatch: true,
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    ensureSchemaLoaded: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    refreshSchema: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    flushFormChanges: vi.fn().mockResolvedValue(true),
    discardFormValue: vi.fn().mockResolvedValue(true),
    subscribe: (listener: () => void) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
  };
  const selectionListeners = new Set<() => void>();
  const selection = {
    state: { selectedId: "main" },
    set: (id: string) => {
      selection.state.selectedId = id;
      for (const listener of selectionListeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
  };
  const navigate = vi.fn();
  const context = {
    basePath: "",
    gateway: gateway.gateway,
    runtimeConfig: runtime,
    settingsAgentSelection: selection,
    agents: {
      state: {
        agentsList: {
          agents: [
            { id: "main", name: "Main" },
            { id: "scout", name: "Scout" },
          ],
        },
      },
      subscribe: () => () => {},
    },
    navigate,
  } as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SearchPage />
    </ApplicationProvider>
  ));
  const element = view.container;
  const settle = async () => {
    flush();
    await settleModelCatalogRequests(client, { agentId: selection.state.selectedId });
    await Promise.allSettled(requested);
    await waitForSolid(() => {
      expect(button(element, i18n.t("searchPage.refresh")).disabled).toBe(false);
    });
  };
  if (options.waitReady === false) {
    flush();
  } else {
    await settle();
  }
  return {
    element,
    input: (label: string) =>
      element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!,
    click: (label: string) => button(element, label).click(),
    calls: (method: string) => request.mock.calls.filter(([name]) => name === method),
    statuses: () =>
      [...element.querySelectorAll('[role="status"]')].map((region) => region.textContent),
    dispose: () => view.unmount(),
    runtime,
    publishRuntime: () => {
      for (const listener of runtimeListeners) {
        listener();
      }
    },
    selection,
    navigate,
    gateway,
    snapshot,
    settle,
    statusRequested: statusRequested.promise,
    setResult: (next: WebSearchStatusResult) => {
      result = next;
    },
    setTestResponse: (next: Promise<unknown>) => {
      testResponse = next;
    },
  };
}

function button(element: Element, text: string) {
  const control = [...element.querySelectorAll("button")].find(
    (candidate) =>
      (
        candidate.querySelector(".settings-row__title")?.textContent ?? candidate.textContent
      )?.trim() === text,
  );
  expect(control, text).toBeDefined();
  return control!;
}
function select(element: Element, label: string, value: string) {
  const field = element.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(field).not.toBeNull();
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
}
function editInput(input: HTMLInputElement, value: string) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.blur();
}

describe("Search settings", () => {
  it("keeps the initial localized query and edited draft when the locale changes", async () => {
    const locale = i18n.getLocale();
    try {
      await i18n.setLocale("pt-BR");
      const fixture = await mount();
      const query = fixture.input(i18n.t("searchPage.query"));
      const initialQuery = i18n.t("searchPage.queryDefault");
      expect(query.value).toBe(initialQuery);

      await i18n.setLocale("en");
      flush();
      expect(i18n.t("searchPage.queryDefault")).not.toBe(initialQuery);
      expect(query.getAttribute("aria-label")).toBe(i18n.t("searchPage.query"));
      expect(query.value).toBe(initialQuery);

      query.value = "My search draft";
      query.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      await i18n.setLocale("pt-BR");
      flush();
      expect(query.getAttribute("aria-label")).toBe(i18n.t("searchPage.query"));
      expect(query.value).toBe("My search draft");
    } finally {
      await i18n.setLocale(locale);
    }
  });

  it.each(["success", "failure"] as const)(
    "resolves current search status after catalog %s without manual refresh",
    async (outcome) => {
      const catalog = createDeferred<ModelCatalogResult>();
      const fixture = await mount({ modelsResponse: catalog.promise, waitReady: false });
      expect(fixture.calls("webSearch.status")).toHaveLength(0);
      if (outcome === "success") {
        fixture.setResult({ ...ready, agentId: "scout" });
        fixture.selection.set("scout");
        catalog.resolve({ models: [{ id: "local", name: "Local model", provider: "example" }] });
      } else {
        catalog.reject(new Error("Model catalog unavailable"));
      }
      await fixture.statusRequested;
      await fixture.settle();
      const statuses = fixture.calls("webSearch.status");
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.[1]).toEqual({ agentId: outcome === "success" ? "scout" : "main" });
      expect(fixture.element.querySelector('select[aria-label="Search provider"]')).not.toBeNull();
      expect(fixture.element.textContent).toContain("Configured");
    },
  );

  it("keeps configured separate from tested and writes explicit and automatic selection through the config owner", async () => {
    const fixture = await mount();
    expect(fixture.element.querySelector(".page-title")?.textContent).toBe("Search");
    expect(fixture.element.textContent).toContain("Configured");
    expect(fixture.statuses()).toContainEqual(expect.stringContaining("Not tested"));
    select(fixture.element, "Search provider", "searxng");
    await fixture.settle();
    expect(fixture.runtime.patchForm).toHaveBeenCalledWith(
      ["tools", "web", "search", "provider"],
      "searxng",
    );
    select(fixture.element, "Search provider", "");
    await fixture.settle();
    expect(fixture.runtime.removeFormValue).toHaveBeenCalledWith([
      "tools",
      "web",
      "search",
      "provider",
    ]);
    fixture.click("Test search");
    await fixture.settle();
    expect(fixture.statuses()).toContainEqual(expect.stringContaining("Search succeeded"));
    expect(fixture.element.querySelector('a[href="https://example.com/docs"]')?.textContent).toBe(
      "Documentation",
    );
  });

  it.each([
    { label: "other subtree", configPath: providerPath, stored: REDACTED_SENTINEL },
    { label: "no settings subtree", configPath: [], stored: REDACTED_SENTINEL },
    { label: "null credential", configPath: [], stored: null },
  ])("reads a credential by its full path ($label)", async ({ configPath, stored }) => {
    const credentialPath = ["plugins", "entries", "searxng", "config", "accounts", 0, "apiKey"];
    const fixture = await mount({
      config: {
        plugins: {
          entries: {
            searxng: {
              config: { webSearch: { apiKey: "" }, accounts: [{ apiKey: stored }] },
            },
          },
        },
      },
      result: {
        ...ready,
        providers: [
          {
            ...ready.providers[0]!,
            configPath,
            credential: { path: credentialPath, label: "Provider credential", envVars: [] },
          },
        ],
      },
    });
    fixture.runtime.state.configSchema = providerPath.reduceRight<unknown>(
      (schema, key) => ({ type: "object", properties: { [key]: schema } }),
      {
        type: "object",
        properties: { apiKey: { type: "string", title: "Independent request key" } },
      },
    );
    fixture.publishRuntime();
    flush();
    const independent = fixture.element.querySelector<HTMLInputElement>(
      'input[aria-label="Independent request key"]',
    );
    if (configPath.length) {
      expect(independent).not.toBeNull();
      editInput(independent!, "synthetic-request-key");
      await fixture.settle();
      expect(fixture.runtime.patchForm).toHaveBeenCalledWith(
        [...providerPath, "apiKey"],
        "synthetic-request-key",
      );
    } else {
      expect(independent).toBeNull();
    }
    const editor = fixture.element.querySelector<HTMLElement>("openclaw-plugin-credential-editor")!;
    flush();
    const input = editor.querySelector<HTMLInputElement>(
      'input[aria-label="Provider credential"]',
    )!;
    expect(input.placeholder).toBe(stored ? "••••••••" : "");
    expect(input.value).toBe("");
    editInput(input, "synthetic-replacement-key");
    await fixture.settle();
    expect(fixture.runtime.patchForm).toHaveBeenCalledWith(
      credentialPath,
      "synthetic-replacement-key",
    );
    if (configPath.length) {
      fixture.setResult({
        ...ready,
        providers: [{ ...ready.providers[0]!, configPath: [] }],
      });
      fixture.click("Refresh search status");
      await fixture.settle();
      expect(fixture.input("Independent request key")).toBeNull();
    }
  });

  it("retries a failed configuration read without attempting a write", async () => {
    const fixture = await mount();
    fixture.runtime.state.lastError = "Could not load search settings";
    fixture.publishRuntime();
    flush();
    fixture.click("Retry");
    await fixture.settle();
    expect(fixture.runtime.refresh).toHaveBeenCalledOnce();
    expect(fixture.runtime.refreshSchema).toHaveBeenCalledOnce();
    expect(fixture.runtime.retry).not.toHaveBeenCalled();
  });

  it.each(["agent", "connection"] as const)(
    "rejects a late successful test after its %s changes",
    async (change) => {
      const fixture = await mount();
      const old = createDeferred<unknown>();
      fixture.setTestResponse(old.promise);
      fixture.click("Test search");
      flush();
      expect(fixture.statuses()).toContainEqual(expect.stringContaining("Searching…"));
      if (change === "agent") {
        fixture.setResult({
          ...ready,
          agentId: "scout",
          route: { kind: "disabled", label: "Off", testable: false },
        });
        select(fixture.element, "Agent", "scout");
      } else {
        fixture.gateway.publish({ ...fixture.snapshot, phase: "stopped", client: null });
        fixture.gateway.publish(fixture.snapshot);
      }
      old.resolve({ provider: "searxng", status: "ok", latencyMs: 1, content: "Obsolete success" });
      await fixture.settle();
      expect(fixture.element.textContent).not.toContain("Obsolete success");
      expect(fixture.element.textContent).not.toContain("Search succeeded");
    },
  );

  it.each(["success", "provider error", "request error"] as const)(
    "locks the tested query until %s settles and clears health on editing",
    async (outcome) => {
      const fixture = await mount();
      const query = fixture.input("Search query");
      query.value = "Query A";
      query.dispatchEvent(new Event("input", { bubbles: true }));
      const pending = createDeferred<unknown>();
      fixture.setTestResponse(pending.promise);
      fixture.click("Test search");
      flush();
      try {
        expect(query.disabled).toBe(true);
        expect(query.value).toBe("Query A");
      } finally {
        if (outcome === "request error") {
          pending.reject(new Error("Previous transport error"));
        } else {
          pending.resolve(
            outcome === "success"
              ? {
                  provider: "searxng",
                  status: "ok",
                  latencyMs: 1,
                  content: "Previous answer",
                  results: [{ title: "Previous source", url: "https://example.com/previous" }],
                }
              : {
                  provider: "searxng",
                  status: "error",
                  latencyMs: 1,
                  error: "Previous provider error",
                },
          );
        }
      }
      await fixture.settle();
      expect(fixture.element.textContent).toContain(
        outcome === "success" ? "Search succeeded" : "Search failed",
      );
      expect(query.disabled).toBe(false);
      expect(fixture.calls("webSearch.test")[0]?.[1]).toMatchObject({ query: "Query A" });
      if (outcome === "success") {
        expect(fixture.element.textContent).toContain("Previous answer");
      }
      query.value = "Query B";
      query.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(fixture.element.textContent).toContain("Not tested");
      expect(fixture.element.textContent).not.toContain("Previous");
      expect(fixture.element.querySelector('a[href="https://example.com/previous"]')).toBeNull();
    },
  );

  it("opens native search in an unsent chat and prevents a reader from testing shared credentials", async () => {
    const fixture = await mount({
      result: {
        ...ready,
        route: {
          kind: "native",
          label: "Native search",
          reason: "Test through the active model in chat.",
          testable: false,
        },
      },
    });
    expect(fixture.input("Search query")).toBeNull();
    expect(
      [...fixture.element.querySelectorAll("button")].map((candidate) =>
        candidate.textContent?.trim(),
      ),
    ).not.toContain("Test search");
    fixture.click("Test in chat");
    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith("new-session", {
      search: "?agent=main&model=example%2Flocal",
    });
    expect(fixture.calls("webSearch.test")).toHaveLength(0);
    fixture.dispose();
    const reader = await mount({ admin: false });
    expect(button(reader.element, "Test search").disabled).toBe(true);
  });

  it("tests an explicitly selected managed provider separately from external harness search", async () => {
    const fixture = await mount({
      result: {
        ...ready,
        provider: "searxng",
        route: {
          kind: "external",
          label: "External harness",
          reason: "Check native search in chat.",
          testable: false,
        },
        testProvider: { id: "searxng", label: "SearXNG" },
      },
    });
    fixture.click("Test SearXNG");
    await fixture.settle();
    expect(fixture.calls("webSearch.test")[0]?.[1]).toMatchObject({
      providerId: "searxng",
      agentId: "main",
    });
    expect(fixture.element.textContent).toContain("Search succeeded");
    expect(fixture.element.textContent).toContain("Check in chat");
  });

  it("renders search output as text and does not make script citations clickable", async () => {
    const fixture = await mount();
    fixture.setTestResponse(
      Promise.resolve({
        provider: "searxng",
        status: "ok",
        latencyMs: 1,
        content: '<img src=x onerror="alert(1)">',
        citations: [{ title: "Unsafe", url: "javascript:alert(1)" }],
      }),
    );
    fixture.click("Test search");
    await fixture.settle();
    expect(fixture.element.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(fixture.element.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(fixture.element.querySelector("img")).toBeNull();
  });
});
