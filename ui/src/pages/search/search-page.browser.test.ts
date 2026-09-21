import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSearchStatusResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import type { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import "./search-page.ts";

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
  let testResponse: Promise<unknown> = Promise.resolve({
    provider: "searxng",
    status: "ok",
    latencyMs: 12,
    results: [
      { title: "Documentation", url: "https://example.com/docs", snippet: "Search result" },
    ],
  });
  const request = createGatewayRequestMock((method) => {
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
    subscribe: () => () => {},
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
  const host = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-search-page") as OpenClawLightDomElement;
  host.append(element);
  document.body.append(host);
  const settle = async () => {
    await element.updateComplete;
    await settleModelCatalogRequests(client, { agentId: selection.state.selectedId });
    await Promise.allSettled(requested);
    await element.updateComplete;
  };
  if (options.waitReady === false) {
    await element.updateComplete;
  } else {
    await settle();
  }
  return {
    element,
    request,
    runtime,
    selection,
    navigate,
    gateway,
    snapshot,
    settle,
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

afterEach(() => document.body.replaceChildren());

describe("Search settings", () => {
  it.each(["success", "failure"] as const)(
    "resolves current search status after catalog %s without manual refresh",
    async (outcome) => {
      const catalog = createDeferred<ModelCatalogResult>();
      const fixture = await mount({ modelsResponse: catalog.promise, waitReady: false });
      expect(fixture.request.mock.calls.some(([method]) => method === "webSearch.status")).toBe(
        false,
      );
      if (outcome === "success") {
        fixture.setResult({ ...ready, agentId: "scout" });
        fixture.selection.set("scout");
        catalog.resolve({ models: [{ id: "local", name: "Local model", provider: "example" }] });
      } else {
        catalog.reject(new Error("Model catalog unavailable"));
      }
      await fixture.settle();
      const statuses = fixture.request.mock.calls.filter(
        ([method]) => method === "webSearch.status",
      );
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
    expect(fixture.element.textContent).toContain("Not tested");
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
    button(fixture.element, "Test search").click();
    await fixture.settle();
    expect(fixture.element.textContent).toContain("Search succeeded");
    expect(fixture.element.querySelector('a[href="https://example.com/docs"]')?.textContent).toBe(
      "Documentation",
    );
  });

  it("edits a custom provider endpoint inline through its canonical plugin configuration", async () => {
    const fixture = await mount();
    fixture.runtime.state.configSchema = providerPath.reduceRight<unknown>(
      (schema, key) => ({ type: "object", properties: { [key]: schema } }),
      { type: "object", properties: { baseUrl: { type: "string", title: "Search endpoint" } } },
    );
    fixture.element.requestUpdate();
    await fixture.element.updateComplete;
    const endpoint = fixture.element.querySelector<HTMLInputElement>(
      'input[aria-label="Search endpoint"]',
    )!;
    expect(endpoint).not.toBeNull();
    expect(endpoint.value).toBe("https://search.example.com");
    endpoint.focus();
    endpoint.value = "https://custom.example.com";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    endpoint.blur();
    await fixture.settle();
    expect(fixture.runtime.patchForm).toHaveBeenCalledWith(
      [...providerPath, "baseUrl"],
      "https://custom.example.com",
    );
    fixture.setResult({
      ...ready,
      providers: ready.providers.map((provider) => ({ ...provider, configPath: [] })),
    });
    button(fixture.element, "Refresh search status").click();
    await fixture.settle();
    expect(fixture.element.querySelector('input[aria-label="Search endpoint"]')).toBeNull();
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
    fixture.element.requestUpdate();
    await fixture.element.updateComplete;
    const independent = fixture.element.querySelector<HTMLInputElement>(
      'input[aria-label="Independent request key"]',
    );
    if (configPath.length) {
      expect(independent).not.toBeNull();
      independent!.focus();
      independent!.value = "synthetic-request-key";
      independent!.dispatchEvent(new Event("input", { bubbles: true }));
      independent!.blur();
      await fixture.settle();
      expect(fixture.runtime.patchForm).toHaveBeenCalledWith(
        [...providerPath, "apiKey"],
        "synthetic-request-key",
      );
    } else {
      expect(independent).toBeNull();
    }
    const editor = fixture.element.querySelector<OpenClawLightDomElement>(
      "openclaw-plugin-credential-editor",
    )!;
    await editor.updateComplete;
    const input = editor.querySelector<HTMLInputElement>(
      'input[aria-label="Provider credential"]',
    )!;
    expect(input.placeholder).toBe(stored ? "••••••••" : "");
    expect(input.value).toBe("");
    input.focus();
    input.value = "synthetic-replacement-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    await fixture.settle();
    expect(fixture.runtime.patchForm).toHaveBeenCalledWith(
      credentialPath,
      "synthetic-replacement-key",
    );
  });

  it("exposes existing advanced search fields without adding another provider selector", async () => {
    const fixture = await mount();
    fixture.runtime.state.configSchema = ["tools", "web", "search"].reduceRight<unknown>(
      (schema, key) => ({ type: "object", properties: { [key]: schema } }),
      {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          provider: { type: "string" },
          maxResults: { type: "integer", title: "Result limit", default: 5 },
        },
      },
    );
    fixture.element.requestUpdate();
    await fixture.element.updateComplete;
    const advanced = fixture.element.querySelector<HTMLDetailsElement>("details")!;
    expect(advanced.open).toBe(false);
    advanced.open = true;
    const limit = advanced.querySelector<HTMLInputElement>('input[aria-label="Result limit"]')!;
    limit.focus();
    limit.value = "8";
    limit.dispatchEvent(new Event("input", { bubbles: true }));
    limit.blur();
    await fixture.settle();
    expect(fixture.runtime.patchForm).toHaveBeenCalledWith(
      ["tools", "web", "search", "maxResults"],
      8,
    );
    expect(fixture.element.querySelectorAll('select[aria-label="Search provider"]')).toHaveLength(
      1,
    );
  });

  it("retries a failed configuration read without attempting a write", async () => {
    const fixture = await mount();
    fixture.runtime.state.lastError = "Could not load search settings";
    fixture.element.requestUpdate();
    await fixture.element.updateComplete;
    button(fixture.element, "Retry").click();
    await fixture.settle();
    expect(fixture.runtime.refresh).toHaveBeenCalledOnce();
    expect(fixture.runtime.refreshSchema).toHaveBeenCalledOnce();
    expect(fixture.runtime.retry).not.toHaveBeenCalled();
  });

  it.each(["agent", "connection", "provider"] as const)(
    "rejects a late successful test after its %s changes",
    async (change) => {
      const fixture = await mount();
      const old = createDeferred<unknown>();
      fixture.setTestResponse(old.promise);
      button(fixture.element, "Test search").click();
      await fixture.element.updateComplete;
      expect(fixture.element.textContent).toContain("Searching…");
      if (change === "agent") {
        fixture.setResult({
          ...ready,
          agentId: "scout",
          route: { kind: "disabled", label: "Off", testable: false },
        });
        select(fixture.element, "Agent", "scout");
      } else if (change === "provider") {
        select(fixture.element, "Search provider", "searxng");
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

  it("keeps the tested query immutable until its request settles", async () => {
    const fixture = await mount();
    const query = fixture.element.querySelector<HTMLInputElement>(
      'input[aria-label="Search query"]',
    )!;
    query.value = "Query A";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    const pending = createDeferred<unknown>();
    fixture.setTestResponse(pending.promise);
    button(fixture.element, "Test search").click();
    await fixture.element.updateComplete;
    try {
      expect(query.disabled).toBe(true);
      expect(query.value).toBe("Query A");
    } finally {
      pending.resolve({
        provider: "searxng",
        status: "ok",
        latencyMs: 1,
        content: "Answer for query A",
      });
      await fixture.settle();
    }
    expect(query.disabled).toBe(false);
    expect(fixture.element.textContent).toContain("Answer for query A");
    expect(
      fixture.request.mock.calls.find(([method]) => method === "webSearch.test")?.[1],
    ).toMatchObject({ query: "Query A" });
  });

  it.each(["success", "provider error", "request error"] as const)(
    "clears a completed search %s when its query is edited",
    async (outcome) => {
      const fixture = await mount();
      const pending = createDeferred<unknown>();
      fixture.setTestResponse(pending.promise);
      button(fixture.element, "Test search").click();
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
      await fixture.settle();
      expect(fixture.element.textContent).toContain(
        outcome === "success" ? "Search succeeded" : "Search failed",
      );
      const query = fixture.element.querySelector<HTMLInputElement>(
        'input[aria-label="Search query"]',
      )!;
      query.value = "Query B";
      query.dispatchEvent(new Event("input", { bubbles: true }));
      await fixture.element.updateComplete;
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
    expect(fixture.element.querySelector('input[aria-label="Search query"]')).toBeNull();
    expect(
      [...fixture.element.querySelectorAll("button")].some(
        (candidate) => candidate.textContent?.trim() === "Test search",
      ),
    ).toBe(false);
    button(fixture.element, "Test in chat").click();
    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith("new-session", {
      search: "?agent=main&model=example%2Flocal",
    });
    expect(fixture.request.mock.calls.some(([method]) => method === "webSearch.test")).toBe(false);
    fixture.element.remove();
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
    button(fixture.element, "Test SearXNG").click();
    await fixture.settle();
    expect(
      fixture.request.mock.calls.find(([method]) => method === "webSearch.test")?.[1],
    ).toMatchObject({ providerId: "searxng", agentId: "main" });
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
    button(fixture.element, "Test search").click();
    await fixture.settle();
    expect(fixture.element.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(fixture.element.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(fixture.element.querySelector("img")).toBeNull();
  });
});
