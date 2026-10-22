import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { WebSearchStatusResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  atPath,
  editInput,
  mountSearch,
  observable,
  providerPath as pathForProvider,
  searchPath,
  searchStatus,
} from "./search-page.test-support.tsx";

const providerPath = pathForProvider("searxng");
const ready = searchStatus("searxng", "SearXNG", { hint: "Self-hosted search" });

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
  let testResponse: Promise<unknown> = Promise.resolve({
    provider: "searxng",
    status: "ok",
    latencyMs: 12,
    results: [
      { title: "Documentation", url: "https://example.com/docs", snippet: "Search result" },
    ],
  });
  const fixture = await mountSearch({
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
    ...fixture,
    settle: () => fixture.settle(true),
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

describe("Search settings", () => {
  it("retains controls and the query draft through a failed refresh and retry", async () => {
    const fixture = await mount();
    const query = fixture.edit("Search query", "Keep my search draft", false);
    const refresh = createDeferred<WebSearchStatusResult>();
    fixture.setStatusResponse(refresh.promise);
    fixture.click("Refresh search status");
    flush();
    await waitForSolid(() => expect(fixture.calls("webSearch.status")).toHaveLength(2));

    expect(fixture.button("Refresh search status").disabled).toBe(true);
    expect(fixture.button("Test search").disabled).toBe(true);
    expect(fixture.input("Search query")).toBe(query);
    expect(fixture.element.textContent).toContain(i18n.t("searchPage.loading"));
    expect(fixture.element.querySelector(".settings-loading-skeleton")).toBeNull();

    refresh.reject(new Error("Search status unavailable"));
    await fixture.settle();
    await waitForSolid(() =>
      expect(fixture.element.querySelector('[role="alert"]')?.textContent).toContain(
        "Search status unavailable",
      ),
    );
    expect(fixture.input("Search query")).toBe(query);
    expect(query.value).toBe("Keep my search draft");

    const retry = createDeferred<WebSearchStatusResult>();
    fixture.setStatusResponse(retry.promise);
    fixture.click("Retry");
    flush();
    await waitForSolid(() => expect(fixture.calls("webSearch.status")).toHaveLength(3));
    expect(fixture.element.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.input("Search query")).toBe(query);
    retry.resolve(ready);
    await fixture.settle();
    expect(fixture.element.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.input("Search query")).toBe(query);
    expect(query.value).toBe("Keep my search draft");
    expect(fixture.calls("webSearch.test")).toHaveLength(0);
  });

  it.each(["connection", "agent"] as const)(
    "retires controls and rejects a failed refresh after the %s changes",
    async (change) => {
      const fixture = await mount();
      const originalQuery = fixture.input("Search query");
      const refresh = createDeferred<WebSearchStatusResult>();
      fixture.setStatusResponse(refresh.promise);
      fixture.click("Refresh search status");
      flush();
      await waitForSolid(() => expect(fixture.calls("webSearch.status")).toHaveLength(2));
      fixture.setStatusResponse(undefined);
      if (change === "connection") {
        fixture.replaceConnection();
      } else {
        fixture.setResult({ ...ready, agentId: "scout" });
        fixture.setAgent("scout");
      }
      flush();
      expect(originalQuery.isConnected).toBe(false);

      refresh.reject(new Error("Retired search status failed"));
      await fixture.settle();
      expect(fixture.element.querySelector('[role="alert"]')).toBeNull();
      expect(fixture.input("Search query")).not.toBe(originalQuery);
      expect(fixture.calls("webSearch.status")).toHaveLength(3);
      expect(fixture.calls("webSearch.status").at(-1)?.[1]).toEqual({
        agentId: change === "agent" ? "scout" : "main",
      });
      expect(fixture.calls("webSearch.test")).toHaveLength(0);
    },
  );

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
    "resolves current search status after catalog %s without manual refresh",
    async (outcome) => {
      const catalog = createDeferred<ModelCatalogResult>();
      const fixture = await mount({ modelsResponse: catalog.promise, waitReady: false });
      expect(fixture.calls("webSearch.status")).toHaveLength(0);
      await waitForSolid(() =>
        expect(fixture.element.querySelector(".settings-loading-skeleton")).not.toBeNull(),
      );
      if (outcome === "success") {
        fixture.setResult({ ...ready, agentId: "scout" });
        fixture.setAgent("scout");
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
      expect(fixture.element.querySelector(".settings-loading-skeleton")).toBeNull();
      expect(fixture.element.textContent).toContain("Configured");
    },
  );

  it("keeps configured separate from tested and writes explicit and automatic selection through the config owner", async () => {
    const fixture = await mount();
    expect(fixture.element.querySelector(".page-title")?.textContent).toBe("Search");
    expect(fixture.element.textContent).toContain("Configured");
    expect(fixture.statuses()).toContainEqual(expect.stringContaining("Not tested"));
    fixture.select("Search provider", "searxng");
    await fixture.settle();
    expect(fixture.runtime.patchForm).toHaveBeenCalledWith([...searchPath, "provider"], "searxng");
    fixture.select("Search provider", "");
    await fixture.settle();
    expect(fixture.runtime.removeFormValue).toHaveBeenCalledWith([...searchPath, "provider"]);
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
      config: atPath(providerPath.slice(0, -1), {
        webSearch: { apiKey: "" },
        accounts: [{ apiKey: stored }],
      }),
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
    fixture.runtime.publish();
    flush();
    const independent = fixture.input("Independent request key");
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
    expect(input).toMatchObject({ placeholder: stored ? "••••••••" : "", value: "" });
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
    fixture.runtime.publish();
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
      await waitForSolid(() =>
        expect(fixture.statuses()).toContainEqual(expect.stringContaining("Searching…")),
      );
      if (change === "agent") {
        fixture.setResult({
          ...ready,
          agentId: "scout",
          route: { kind: "disabled", label: "Off", testable: false },
        });
        fixture.select("Agent", "scout");
      } else {
        fixture.gateway.publish({ ...fixture.snapshot, phase: "stopped", client: null });
        fixture.gateway.publish(fixture.snapshot);
      }
      try {
        await waitForSolid(() =>
          expect(fixture.statuses()).toContainEqual(expect.stringContaining("Not tested")),
        );
      } finally {
        old.resolve({
          provider: "searxng",
          status: "ok",
          latencyMs: 1,
          content: "Obsolete success",
        });
      }
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
      editInput(query, "Query A", false);
      const pending = createDeferred<unknown>();
      fixture.setTestResponse(pending.promise);
      fixture.click("Test search");
      fixture.click("Test search");
      expect(fixture.calls("webSearch.test")).toHaveLength(1);
      try {
        await waitForSolid(() =>
          expect({ disabled: query.disabled, value: query.value }).toEqual({
            disabled: true,
            value: "Query A",
          }),
        );
      } finally {
        if (outcome === "request error") {
          pending.reject(new Error("Previous transport error"));
        } else {
          pending.resolve({
            provider: "searxng",
            latencyMs: 1,
            ...(outcome === "success"
              ? {
                  status: "ok",
                  content: "Previous answer",
                  results: [{ title: "Previous source", url: "https://example.com/previous" }],
                }
              : { status: "error", error: "Previous provider error" }),
          });
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
      editInput(query, "Query B", false);
      flush();
      expect(fixture.element.textContent).toContain("Not tested");
      expect(fixture.element.textContent).not.toContain("Previous");
      expect(fixture.element.querySelector('a[href="https://example.com/previous"]')).toBeNull();
    },
  );

  it.each(["native", "external"] as const)(
    "routes %s search to chat and tests only managed credentials",
    async (kind) => {
      const external = kind === "external";
      const fixture = await mount({
        result: {
          ...ready,
          ...(external
            ? { provider: "searxng", testProvider: { id: "searxng", label: "SearXNG" } }
            : {}),
          route: {
            kind,
            label: external ? "External harness" : "Native search",
            reason: external
              ? "Check native search in chat."
              : "Test through the active model in chat.",
            testable: false,
          },
        },
      });
      if (external) {
        fixture.click("Test SearXNG");
        await fixture.settle();
        expect(fixture.calls("webSearch.test")[0]?.[1]).toMatchObject({
          providerId: "searxng",
          agentId: "main",
        });
        expect(fixture.element.textContent).toContain("Search succeeded");
        expect(fixture.element.textContent).toContain("Check in chat");
        return;
      }
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
      expect(reader.button("Test search").disabled).toBe(true);
    },
  );

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
