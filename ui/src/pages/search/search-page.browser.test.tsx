import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ConfigSnapshot, ModelCatalogResult } from "../../api/types.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  atPath,
  editInput,
  mountSearch,
  observable,
  pendingResult,
  providerPath as pathForProvider,
  searchPath,
  searchStatus,
} from "./search-page.test-support.tsx";

describe("Search settings", () => {
  const providerPath = pathForProvider("searxng");
  const ready = searchStatus("searxng", "SearXNG", { hint: "Self-hosted search" });
  const unsafeContent = '<img src=x onerror="alert(1)">';
  const searchResult = (overrides: Partial<WebSearchTestResult>): WebSearchTestResult => ({
    provider: "searxng",
    status: "ok",
    latencyMs: 1,
    ...overrides,
  });

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
    let statusResponse: Promise<WebSearchStatusResult> | undefined;
    const statusRequested = createDeferred();
    let testResponse: Promise<unknown> = Promise.resolve(searchResult({}));
    const page = await mountSearch({
      hello: gatewayHelloForMethods(
        [],
        options.admin === false ? ["operator.read"] : ["operator.admin"],
      ),
      waitReady: options.waitReady,
      waitForRefresh: true,
      respond: (method) => {
        if (method === "webSearch.status") {
          statusRequested.resolve();
        }
        return method === "webSearch.status"
          ? (statusResponse ?? Promise.resolve(result))
          : method === "webSearch.test"
            ? testResponse
            : method === "models.list"
              ? (options.modelsResponse ?? Promise.resolve({ models: [] }))
              : method === "plugins.credentials.inspect"
                ? Promise.resolve({ baseHash: "one", credential: { kind: "missing" } })
                : Promise.resolve({});
      },
      runtime: (_gateway, snapshot) => {
        const config = options.config ?? {
          ...atPath(searchPath, { enabled: true }),
          ...atPath(providerPath, { baseUrl: "https://search.example.com" }),
        };
        const source = observable({
          ...createInitialConfigState(snapshot),
          configForm: config,
          configSnapshot: { config, hash: "one", valid: true, issues: [] },
        });
        return {
          ...source,
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
        };
      },
    });
    return {
      ...page,
      settle: () => page.settle(true),
      statusRequested: statusRequested.promise,
      setResult: (next: WebSearchStatusResult) => {
        result = next;
      },
      setStatusResponse: (next: Promise<WebSearchStatusResult> | undefined) => {
        statusResponse = next;
      },
      setTestResponse: (next: Promise<unknown>) => {
        testResponse = next;
      },
    };
  }

  it("preserves drafts through status and config read recovery", async () => {
    const page = await mount();
    const query = page.edit("Search query", "Keep my search draft", false);
    const refresh = createDeferred<WebSearchStatusResult>();
    page.setStatusResponse(refresh.promise);
    page.click("Refresh search status");
    flush();
    await waitForSolid(() => expect(page.calls("webSearch.status")).toHaveLength(2));

    expect(page.button("Refresh search status").disabled).toBe(true);
    expect(page.button("Test search").disabled).toBe(true);
    expect(page.input("Search query")).toBe(query);
    page.expectText(i18n.t("searchPage.loading"));
    expect(page.element.querySelector(".settings-loading-skeleton")).toBeNull();

    refresh.reject(new Error("Search status unavailable"));
    await page.settle();
    await waitForSolid(() =>
      expect(page.element.querySelector('[role="alert"]')?.textContent).toContain(
        "Search status unavailable",
      ),
    );
    expect(page.input("Search query")).toBe(query);
    expect(query.value).toBe("Keep my search draft");

    const retry = createDeferred<WebSearchStatusResult>();
    page.setStatusResponse(retry.promise);
    page.click("Retry");
    flush();
    await waitForSolid(() => expect(page.calls("webSearch.status")).toHaveLength(3));
    expect(page.element.querySelector('[role="alert"]')).toBeNull();
    expect(page.input("Search query")).toBe(query);
    retry.resolve(ready);
    await page.settle();
    expect(page.element.querySelector('[role="alert"]')).toBeNull();
    expect(page.input("Search query")).toBe(query);
    expect(query.value).toBe("Keep my search draft");
    expect(page.calls("webSearch.test")).toHaveLength(0);
    page.runtime.state.lastError = "Could not load search settings";
    page.runtime.publish();
    flush();
    page.click("Retry");
    await page.settle();
    expect(page.runtime.refresh).toHaveBeenCalledOnce();
    expect(page.runtime.refreshSchema).toHaveBeenCalledOnce();
    expect(page.runtime.retry).not.toHaveBeenCalled();
  });

  it.each([
    ["status", "connection"],
    ["status", "agent"],
    ["test", "connection"],
    ["test", "agent"],
  ] as const)("retires a %s response after its %s changes", async (request, change) => {
    const page = await mount();
    const originalQuery = page.input("Search query");
    const refresh = createDeferred<WebSearchStatusResult>();
    const test = createDeferred<unknown>();
    if (request === "status") {
      page.setStatusResponse(refresh.promise);
      page.click("Refresh search status");
      await waitForSolid(() => expect(page.calls("webSearch.status")).toHaveLength(2));
      page.setStatusResponse(undefined);
    } else {
      page.setTestResponse(test.promise);
      page.click("Test search");
      await waitForSolid(() => page.expectStatus("Searching…"));
    }
    try {
      if (change === "agent") {
        page.setResult({
          ...ready,
          agentId: "scout",
          route:
            request === "test" ? { kind: "disabled", label: "Off", testable: false } : ready.route,
        });
        page.select("Agent", "scout");
      } else if (request === "status") {
        page.replaceConnection();
      } else {
        page.gateway.publish({ ...page.snapshot, phase: "stopped", client: null });
        page.gateway.publish(page.snapshot);
      }
      if (request === "test") {
        await waitForSolid(() => page.expectStatus("Not tested"));
      } else {
        flush();
      }
      expect(originalQuery.isConnected).toBe(false);
    } finally {
      if (request === "status") {
        refresh.reject(new Error("Retired search status failed"));
      } else {
        test.resolve(searchResult({ content: "Obsolete success" }));
      }
    }
    await page.settle();
    page.expectNoText("Obsolete success", "Search succeeded");
    expect(page.element.querySelector('[role="alert"]')).toBeNull();
    expect(page.input("Search query")).not.toBe(originalQuery);
    expect(page.calls("webSearch.status").at(-1)?.[1]).toEqual({
      agentId: change === "agent" ? "scout" : "main",
    });
    expect(page.calls("webSearch.test")).toHaveLength(request === "status" ? 0 : 1);
  });

  it("preserves the localized draft across locale changes", async () => {
    const locale = i18n.getLocale();
    try {
      await i18n.setLocale("pt-BR");
      const page = await mount();
      const query = page.input(i18n.t("searchPage.query"));
      const initialQuery = i18n.t("searchPage.queryDefault");
      expect(query.value).toBe(initialQuery);

      await i18n.setLocale("en");
      flush();
      expect(i18n.t("searchPage.queryDefault")).not.toBe(initialQuery);
      expect(query.getAttribute("aria-label")).toBe(i18n.t("searchPage.query"));
      expect(query.value).toBe(initialQuery);

      editInput(query, "My search draft", false);
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
    "loads current status after catalog %s",
    async (outcome) => {
      const catalog = createDeferred<ModelCatalogResult>();
      const page = await mount({ modelsResponse: catalog.promise, waitReady: false });
      expect(page.calls("webSearch.status")).toHaveLength(0);
      await waitForSolid(() =>
        expect(page.element.querySelector(".settings-loading-skeleton")).not.toBeNull(),
      );
      if (outcome === "success") {
        page.setResult({ ...ready, agentId: "scout" });
        page.setAgent("scout");
        catalog.resolve({ models: [{ id: "local", name: "Local model", provider: "example" }] });
      } else {
        catalog.reject(new Error("Model catalog unavailable"));
      }
      await page.statusRequested;
      await page.settle();
      const statuses = page.calls("webSearch.status");
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.[1]).toEqual({ agentId: outcome === "success" ? "scout" : "main" });
      expect(page.element.querySelector('select[aria-label="Search provider"]')).not.toBeNull();
      expect(page.element.querySelector(".settings-loading-skeleton")).toBeNull();
      page.expectText("Configured");
    },
  );

  it("commits explicit and automatic provider selection", async () => {
    const page = await mount();
    page.expectText("Configured");
    page.expectStatus("Not tested");
    page.select("Search provider", "searxng");
    await page.settle();
    expect(page.runtime.patchForm).toHaveBeenCalledWith([...searchPath, "provider"], "searxng");
    page.select("Search provider", "");
    await page.settle();
    expect(page.runtime.removeFormValue).toHaveBeenCalledWith([...searchPath, "provider"]);
  });

  it("reads credentials outside the settings subtree and hides missing settings", async () => {
    const credentialPath = ["plugins", "entries", "searxng", "config", "accounts", 0, "apiKey"];
    const page = await mount({
      config: atPath(providerPath.slice(0, -1), {
        webSearch: { apiKey: "" },
        accounts: [{ apiKey: REDACTED_SENTINEL }],
      }),
      result: searchStatus("searxng", "SearXNG", {
        configPath: providerPath,
        credential: { path: credentialPath, label: "Provider credential", envVars: [] },
      }),
    });
    page.runtime.state.configSchema = providerPath.reduceRight<unknown>(
      (schema, key) => ({ type: "object", properties: { [key]: schema } }),
      {
        type: "object",
        properties: { apiKey: { type: "string", title: "Independent request key" } },
      },
    );
    page.runtime.publish();
    flush();
    page.edit("Independent request key", "synthetic-request-key");
    await page.settle();
    expect(page.runtime.patchForm).toHaveBeenCalledWith(
      [...providerPath, "apiKey"],
      "synthetic-request-key",
    );
    const input = page.input("Provider credential");
    expect(input).toMatchObject({ placeholder: "••••••••", value: "" });
    editInput(input, "synthetic-replacement-key");
    await page.settle();
    expect(page.runtime.patchForm).toHaveBeenCalledWith(
      credentialPath,
      "synthetic-replacement-key",
    );
    page.setResult(searchStatus("searxng", "SearXNG", { configPath: [] }));
    page.click("Refresh search status");
    await page.settle();
    expect(page.input("Independent request key")).toBeNull();
  });

  it.each(["success", "provider error", "request error"] as const)(
    "locks the query through %s and clears health on editing",
    async (outcome) => {
      const page = await mount();
      const query = page.input("Search query");
      const button = page.button("Test search");
      editInput(query, "Query A", false);
      const pending = createDeferred<unknown>();
      page.setTestResponse(pending.promise);
      page.click("Test search");
      page.click("Test search");
      expect(page.calls("webSearch.test")).toHaveLength(1);
      try {
        await waitForSolid(() => expect(query).toMatchObject({ disabled: true, value: "Query A" }));
      } finally {
        if (outcome === "request error") {
          pending.reject(new Error("Previous transport error"));
        } else {
          pending.resolve(
            searchResult(
              outcome === "success"
                ? {
                    status: "ok",
                    content: `Previous answer ${unsafeContent}`,
                    results: [
                      {
                        title: "Docs",
                        url: "https://a.test/previous",
                        snippet: "Source",
                      },
                    ],
                    citations: [{ title: "Unsafe", url: "javascript:alert(1)" }],
                  }
                : { status: "error", error: "Previous provider error" },
            ),
          );
        }
      }
      await page.settle();
      page.expectText(outcome === "success" ? "Search succeeded" : "Search failed");
      expect(query.disabled).toBe(false);
      expect(page.calls("webSearch.test")[0]?.[1]).toMatchObject({ query: "Query A" });
      if (outcome === "success") {
        page.expectText("Previous answer", unsafeContent);
        expect(page.element.querySelector('a[href="https://a.test/previous"]')?.textContent).toBe(
          "Docs",
        );
        expect(page.element.querySelector('a[href^="javascript:"]')).toBeNull();
        expect(page.element.querySelector("img")).toBeNull();
      }
      if (outcome === "request error") {
        page.expectText("Previous transport error");
        const retry = pendingResult(searchResult({ content: "Previous retry" }));
        page.setTestResponse(retry.promise);
        button.click();
        await waitForSolid(() => {
          page.expectNoText("Previous transport error");
          page.expectStatus("Searching…");
          expect(page.input("Search query")).toBe(query);
          expect(query.disabled).toBe(true);
          expect(page.button("Searching…")).toBe(button);
        });
        retry.complete();
        await waitForSolid(() => {
          page.expectText("Previous retry");
          page.expectStatus("Search succeeded");
          expect(page.button("Test search")).toBe(button);
          expect(query.disabled).toBe(false);
        });
      }
      editInput(query, "Query B", false);
      flush();
      page.expectText("Not tested");
      page.expectNoText("Previous");
      expect(page.element.querySelector('a[href="https://a.test/previous"]')).toBeNull();
    },
  );

  it("submits Enter but ignores IME confirmation", async () => {
    const page = await mount();
    const query = page.input("Search query");
    editInput(query, "東京", false);
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await page.settle();
    expect(page.calls("webSearch.test")).toHaveLength(1);
    expect(page.calls("webSearch.test")[0]?.[1]).toMatchObject({ query: "東京" });

    editInput(query, "おおさか", false);
    query.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    flush();
    expect(page.calls("webSearch.test")).toHaveLength(1);

    // WebKit can deliver the committing Enter just after compositionend with both flags cleared.
    editInput(query, "大阪", false);
    query.dispatchEvent(new CompositionEvent("compositionend", { data: "大阪", bubbles: true }));
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flush();
    expect(page.calls("webSearch.test")).toHaveLength(1);
  });

  it.each(["native", "external"] as const)(
    "routes %s search to chat and tests only managed credentials",
    async (kind) => {
      const external = kind === "external";
      const page = await mount({
        result: {
          ...ready,
          ...(external
            ? { provider: "searxng", testProvider: { id: "searxng", label: "SearXNG" } }
            : {}),
          route: {
            ...ready.route,
            kind,
            testable: false,
          },
        },
      });
      if (external) {
        page.click("Test SearXNG");
        await page.settle();
        expect(page.calls("webSearch.test")[0]?.[1]).toMatchObject({
          providerId: "searxng",
          agentId: "main",
        });
        page.expectText("Search succeeded", "Check in chat");
        return;
      }
      expect(page.input("Search query")).toBeNull();
      page.click("Test in chat");
      expect(page.navigate).toHaveBeenCalledExactlyOnceWith("new-session", {
        search: "?agent=main&model=example%2Flocal",
      });
      expect(page.calls("webSearch.test")).toHaveLength(0);
      page.dispose();
      const reader = await mount({ admin: false });
      expect(reader.button("Test search").disabled).toBe(true);
    },
  );
});

describe("Search configuration lifecycle", () => {
  const providerPath = pathForProvider("example");
  const endpointPath = [...providerPath, "baseUrl"];
  const config = {
    ...atPath([...searchPath, "provider"], "example"),
    ...atPath(providerPath, {
      baseUrl: "https://initial.example.test",
      apiKey: "synthetic-original-key",
    }),
  };
  const ready = searchStatus("example", "Example Search", {
    requiresCredential: true,
    credentialSource: "config",
    credential: { path: [...providerPath, "apiKey"], label: "Example API key", envVars: [] },
  });
  const testResult = {
    status: "ok",
    provider: "example",
    latencyMs: 1,
    content: "Health from the original configuration",
  } satisfies WebSearchTestResult;

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  function schemaAt(path: string[], properties: NonNullable<JsonSchema["properties"]>) {
    return path.reduceRight<JsonSchema>(
      (child, key) => ({ type: "object", properties: { [key]: child } }),
      { type: "object", properties },
    );
  }

  async function mount(
    options: { advanced?: boolean; searchResponse?: Promise<WebSearchTestResult> } = {},
  ) {
    const schema = schemaAt(providerPath, {
      baseUrl: { type: "string", title: "Search endpoint" },
      apiKey: { type: "string", title: "Example API key" },
    });
    if (options.advanced) {
      Object.assign(
        (schema.properties ??= {}),
        schemaAt(searchPath, {
          enabled: { type: "boolean" },
          provider: { type: "string" },
          maxResults: { type: "integer", title: "Result limit", default: 5 },
        }).properties,
      );
    }
    const stored: ConfigSnapshot = {
      config: structuredClone(config),
      sourceConfig: structuredClone(config),
      raw: JSON.stringify(config),
      hash: "saved-1",
      configRevisionHash: "revision-1",
      appliedConfigHash: "revision-1",
      valid: true,
      issues: [],
    };
    const save = createDeferred<unknown>();
    const writeStarted = createDeferred<{ raw: string; baseHash: string }>();
    const searchResponse = options.searchResponse ?? Promise.resolve(testResult);
    let statusResponse: Promise<WebSearchStatusResult> | undefined;
    const responses: Record<string, (params: unknown) => Promise<unknown>> = {
      "config.get": async () => structuredClone(stored),
      "config.schema": async () => ({ schema, uiHints: {}, version: "test-1", generatedAt: "" }),
      "config.set": (params) => {
        writeStarted.resolve(params as { raw: string; baseHash: string });
        return save.promise;
      },
      "models.list": async () => ({ models: [] }),
      "plugins.credentials.inspect": async () => ({
        baseHash: stored.hash,
        credential: { kind: "literal" },
      }),
      "webSearch.status": async () =>
        statusResponse ?? {
          ...ready,
          route: { ...ready.route, label: `Runtime ${stored.appliedConfigHash}` },
        },
      "webSearch.test": () => searchResponse,
    };
    const page = await mountSearch({
      respond: (method, params) => {
        const respond = Object.hasOwn(responses, method) ? responses[method] : undefined;
        if (!respond) {
          throw new Error(`Unexpected request: ${method}`);
        }
        return respond(params);
      },
      hello: gatewayHelloForMethods([...Object.keys(responses), "config.apply", "config.patch"]),
      agents: ["main"],
      waitForRefresh: true,
      runtime: async (gateway) => {
        const runtime = createRuntimeConfigCapability(gateway);
        await runtime.ensureLoaded();
        await runtime.ensureSchemaLoaded();
        return runtime;
      },
      cleanup: (runtime) => runtime.dispose(),
    });
    return {
      ...page,
      testButton: () => page.button("Test search"),
      save,
      rejectSave: () =>
        save.reject(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "Synthetic save rejected" }),
        ),
      writeStarted,
      setStored: (patch: Partial<ConfigSnapshot>) => Object.assign(stored, patch),
      setStatusResponse: (next: Promise<WebSearchStatusResult> | undefined) => {
        statusResponse = next;
      },
    };
  }

  it.each([
    { label: "Search endpoint", value: "https://replacement.example.test" },
    { label: "Result limit", value: "9" },
  ])("rejects a retired $label blur after replacing the connection", async ({ label, value }) => {
    const page = await mount({ advanced: true });
    if (label === "Result limit") {
      const advanced = page.element.querySelector<HTMLDetailsElement>("details")!;
      expect(advanced.open).toBe(false);
      advanced.open = true;
    }
    const field = page.input(label);
    if (label === "Search endpoint") {
      expect(field.value).toBe("https://initial.example.test");
    }
    await page.runtime.refresh({ background: true });
    await page.settle();
    expect(page.input(label)).toBe(field);
    page.edit(label, value, false);

    page.replaceConnection();
    await page.settle();
    const current = page.input(label);
    expect(current).toMatchObject({ disabled: false });
    expect(current).not.toBe(field);
    expect(field.isConnected).toBe(false);
    field.dispatchEvent(new FocusEvent("blur"));
    await page.settle();
    expect(page.calls("config.set")).toHaveLength(0);
    expect(page.runtime.state.configFormDirty).toBe(false);

    if (label === "Result limit") {
      page.element.querySelector<HTMLDetailsElement>("details")!.open = true;
    }
    page.edit(label, value);
    const submitted = await page.writeStarted.promise;
    expect(submitted.baseHash).toBe("saved-1");
    const expected =
      label === "Search endpoint"
        ? atPath(endpointPath, value)
        : atPath([...searchPath, "maxResults"], Number(value));
    expect(JSON.parse(submitted.raw)).toMatchObject(expected);
    page.save.resolve({ config: JSON.parse(submitted.raw), hash: "saved-2" });
    await page.runtime.flushFormChanges();
  });

  it.each([
    { label: "Search endpoint", phase: "pending" },
    { label: "Search endpoint", phase: "rejected" },
    { label: "Search endpoint", phase: "pending reverted" },
    { label: "Example API key", phase: "rejected" },
  ])("blocks tests for a $phase $label save while allowing repair", async ({ label, phase }) => {
    const page = await mount();
    const field = page.edit(label, "synthetic-replacement");
    const committed = page.runtime.flushFormChanges();
    await page.writeStarted.promise;
    if (label === "Example API key") {
      await vi.advanceTimersByTimeAsync(0);
      await waitForSolid(() => expect(field.disabled).toBe(true));
    }
    if (phase === "pending reverted") {
      page.runtime.patchForm(endpointPath, "https://initial.example.test");
    }
    if (phase === "rejected") {
      page.rejectSave();
      await committed;
    }
    flush();
    try {
      expect(page.runtime.state.configFormDirty).toBe(phase !== "pending reverted");
      expect(page.testButton().disabled).toBe(true);
      page.testButton().click();
      expect(page.calls("webSearch.test")).toHaveLength(0);
      if (phase === "rejected") {
        await waitForSolid(() => {
          expect(field).toMatchObject({ isConnected: true, disabled: false });
          expect(page.input(label)).toBe(field);
        });
        page.expectText("Synthetic save rejected");
        expect(page.button("Retry")).toBeDefined();
      }
    } finally {
      if (phase !== "rejected") {
        page.rejectSave();
        await committed;
      }
    }
  });

  it.each(["completed", "success", "request error"] as const)(
    "invalidates %s health when an external draft appears",
    async (outcome) => {
      const pending = pendingResult(testResult);
      const page = await mount({ searchResponse: pending.promise });
      page.testButton().click();
      if (outcome === "completed") {
        pending.complete();
        await page.settle(true);
        page.expectText(testResult.content);
      } else {
        await waitForSolid(() => expect(page.input("Search query").disabled).toBe(true));
      }
      page.runtime.patchForm(endpointPath, "https://draft.example.test");
      await waitForSolid(() => page.expectStatus("Not tested"));
      if (outcome === "request error") {
        pending.reject(new Error("Retired search request failed"));
      } else {
        pending.complete();
      }
      await page.settle(true);
      page.expectNoText(testResult.content, "Retired search request failed");
      page.expectStatus("Not tested");
      expect(page.testButton().disabled).toBe(true);
    },
  );

  it.each(["success", "request error"] as const)(
    "reloads status after configuration advances before %s",
    async (outcome) => {
      const page = await mount();
      const pending = pendingResult({
        ...ready,
        route: { ...ready.route, label: "Retired route" },
      });
      page.setStatusResponse(pending.promise);
      page.click("Refresh search status");
      await waitForSolid(() => expect(page.calls("webSearch.status")).toHaveLength(2));
      page.setStatusResponse(undefined);
      page.setStored({
        hash: "saved-2",
        configRevisionHash: "revision-2",
        appliedConfigHash: "revision-2",
      });
      await page.runtime.refresh({ background: true });
      if (outcome === "success") {
        pending.complete();
      } else {
        pending.reject(new Error("Retired status failed"));
      }
      await page.settle();
      await waitForSolid(() => page.expectText("Runtime revision-2"));
      page.expectNoText("Retired route", "Retired status failed");
      expect(page.calls("webSearch.test")).toHaveLength(0);
    },
  );

  it("waits for activation and refreshes on applied revision changes", async () => {
    const page = await mount();
    page.edit("Search endpoint", "https://next.example.test");
    const committed = page.runtime.flushFormChanges();
    const submitted = await page.writeStarted.promise;
    const saved = JSON.parse(submitted.raw) as Record<string, unknown>;
    page.setStored({
      config: saved,
      sourceConfig: saved,
      raw: submitted.raw,
      hash: "saved-2",
      configRevisionHash: "revision-2",
    });
    page.save.resolve({ config: saved, hash: "saved-2" });
    await committed;
    await vi.advanceTimersByTimeAsync(250);
    await page.settle();
    expect(page.testButton().disabled).toBe(true);
    page.expectText("Runtime revision-1");
    const savedHash = page.runtime.state.configSnapshot?.hash;
    page.setStored({ appliedConfigHash: "revision-2" });
    await vi.advanceTimersByTimeAsync(750);
    await page.settle();
    expect(page.runtime.state.configSnapshot?.hash).toBe(savedHash);
    page.expectText("Runtime revision-2");
    expect(page.testButton().disabled).toBe(false);
  });
});
