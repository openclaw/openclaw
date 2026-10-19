import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { settleModelCatalogRequests } from "../../lib/model-catalog-store.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SearchPage } from "./search-page.tsx";

const providerPath = ["plugins", "entries", "example", "config", "webSearch"];
const endpointPath = [...providerPath, "baseUrl"];
const config = {
  tools: { web: { search: { provider: "example" } } },
  plugins: {
    entries: {
      example: {
        config: {
          webSearch: { baseUrl: "https://initial.example.test", apiKey: "synthetic-original-key" },
        },
      },
    },
  },
};
const provider: WebSearchStatusResult["providers"][number] = {
  id: "example",
  pluginId: "example",
  label: "Example Search",
  hint: "Synthetic provider",
  configured: true,
  installed: true,
  available: true,
  requiresCredential: true,
  credentialSource: "config",
  configPath: providerPath,
  credential: { path: [...providerPath, "apiKey"], label: "Example API key", envVars: [] },
};
const testResult: WebSearchTestResult = {
  status: "ok",
  provider: "example",
  latencyMs: 1,
  content: "Health from the original configuration",
};

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

function schemaAt(path: string[], properties: NonNullable<JsonSchema["properties"]>) {
  return path.reduceRight<JsonSchema>(
    (child, key) => ({ type: "object", properties: { [key]: child } }),
    { type: "object", properties },
  );
}

async function mount(options: { advanced?: boolean } = {}) {
  const providerSchema = schemaAt(providerPath, {
    baseUrl: { type: "string", title: "Search endpoint" },
    apiKey: { type: "string", title: "Example API key" },
  });
  const schema = {
    ...providerSchema,
    properties: {
      ...providerSchema.properties,
      ...(options.advanced
        ? schemaAt(["tools", "web", "search"], {
            enabled: { type: "boolean" },
            provider: { type: "string" },
            maxResults: { type: "integer", title: "Result limit", default: 5 },
          }).properties
        : {}),
    },
  };
  let stored: ConfigSnapshot = {
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
  const searchResponse = Promise.resolve(testResult);
  const reads: Promise<unknown>[] = [];
  const tests: Promise<unknown>[] = [];
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
      ({
        enabled: true,
        provider: "example",
        agentId: "main",
        model: { provider: "example", id: "local", runtime: "openclaw" },
        route: {
          kind: "managed",
          provider: "example",
          label: `Runtime ${stored.appliedConfigHash}`,
          testable: true,
        },
        providers: [provider],
      }) satisfies WebSearchStatusResult,
    "webSearch.test": () => searchResponse,
  };
  const request = createGatewayRequestMock((method, params) => {
    const respond = Object.hasOwn(responses, method) ? responses[method] : undefined;
    if (!respond) {
      throw new Error(`Unexpected request: ${method}`);
    }
    const response = respond(params);
    if (method === "webSearch.test") {
      tests.push(response);
    } else if (method !== "config.set") {
      reads.push(response);
    }
    return response;
  });
  let client = createTestGatewayClient(request);
  const connection = createApplicationGateway({
    client,
    phase: "connected",
    sessionKey: "main",
    hello: gatewayHelloForMethods([
      "config.get",
      "config.schema",
      "config.set",
      "config.apply",
      "config.patch",
      "models.list",
      "webSearch.status",
      "webSearch.test",
      "plugins.credentials.inspect",
    ]),
  } as ApplicationGatewaySnapshot);
  const { gateway } = connection;
  const runtime = createRuntimeConfigCapability(gateway);
  await runtime.ensureLoaded();
  await runtime.ensureSchemaLoaded();
  const context = {
    basePath: "",
    gateway,
    runtimeConfig: runtime,
    agents: {
      state: { agentsList: { agents: [{ id: "main", name: "Main" }] } },
      subscribe: () => () => {},
    },
    settingsAgentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SearchPage />
    </ApplicationProvider>
  ));
  const element = view.container;
  onTestFinished(() => {
    view.unmount();
    runtime.dispose();
  });
  const settle = async (includeTests = false) => {
    flush();
    await settleModelCatalogRequests(client, { agentId: "main" });
    await Promise.allSettled(reads);
    if (includeTests) {
      await Promise.allSettled(tests);
    }
    flush();
  };
  await settle();
  return {
    element,
    runtime,
    calls: (method: string) => request.mock.calls.filter(([name]) => name === method),
    input: (label: string) =>
      element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!,
    testButton: () => testButton(element),
    save,
    writeStarted,
    settle,
    replaceConnection: () => {
      client = createTestGatewayClient(request);
      connection.publish({ ...gateway.snapshot, client });
    },
    setStored: (snapshot: ConfigSnapshot) => {
      stored = snapshot;
    },
    stored: () => stored,
  };
}

function testButton(element: Element) {
  const button = [...element.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Test search",
  );
  expect(button).toBeDefined();
  return button!;
}
function edit(element: Element, label: string, value: string) {
  const input = element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.blur();
  return input;
}

describe("Search configuration lifecycle", () => {
  it.each([
    { label: "Search endpoint", value: "https://replacement.example.test" },
    { label: "Result limit", value: "9" },
  ])("rejects a retired $label blur after replacing the connection", async ({ label, value }) => {
    const fixture = await mount({ advanced: true });
    if (label === "Result limit") {
      const advanced = fixture.element.querySelector<HTMLDetailsElement>("details")!;
      expect(advanced.open).toBe(false);
      advanced.open = true;
    }
    const field = fixture.input(label);
    expect(field).not.toBeNull();
    if (label === "Search endpoint") {
      expect(field.value).toBe("https://initial.example.test");
    }
    await fixture.runtime.refresh({ background: true });
    await fixture.settle();
    expect(fixture.input(label)).toBe(field);
    field.focus();
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));

    fixture.replaceConnection();
    await fixture.settle();
    const current = fixture.input(label);
    expect(current).not.toBeNull();
    expect(current).not.toBe(field);
    expect(current.disabled).toBe(false);
    expect(field.isConnected).toBe(false);
    field.dispatchEvent(new FocusEvent("blur"));
    await fixture.settle();
    expect(fixture.calls("config.set")).toHaveLength(0);
    expect(fixture.runtime.state.configFormDirty).toBe(false);

    if (label === "Result limit") {
      fixture.element.querySelector<HTMLDetailsElement>("details")!.open = true;
    }
    edit(fixture.element, label, value);
    const submitted = await fixture.writeStarted.promise;
    expect(submitted.baseHash).toBe("saved-1");
    expect(JSON.parse(submitted.raw)).toMatchObject(
      label === "Search endpoint"
        ? { plugins: { entries: { example: { config: { webSearch: { baseUrl: value } } } } } }
        : { tools: { web: { search: { maxResults: Number(value) } } } },
    );
    expect(fixture.element.querySelectorAll('select[aria-label="Search provider"]')).toHaveLength(
      1,
    );
    fixture.save.resolve({ config: JSON.parse(submitted.raw), hash: "saved-2" });
    await fixture.runtime.flushFormChanges();
  });

  it.each([
    { label: "Search endpoint", phase: "pending" },
    { label: "Search endpoint", phase: "rejected" },
    { label: "Search endpoint", phase: "pending reverted" },
    { label: "Example API key", phase: "pending" },
    { label: "Example API key", phase: "rejected" },
  ])("blocks tests for a $phase $label save while allowing repair", async ({ label, phase }) => {
    const fixture = await mount();
    const field = edit(fixture.element, label, "synthetic-replacement");
    const committed = fixture.runtime.flushFormChanges();
    await fixture.writeStarted.promise;
    if (phase === "pending reverted") {
      fixture.runtime.patchForm(endpointPath, "https://initial.example.test");
    }
    if (phase === "rejected") {
      fixture.save.reject(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Synthetic save rejected" }),
      );
      await committed;
    }
    flush();
    try {
      expect(fixture.runtime.state).toMatchObject({
        configSaving: false,
        configFormDirty: phase !== "pending reverted",
        configAutoSaveStatus: phase === "rejected" ? "error" : "saving",
      });
      expect(fixture.testButton().disabled).toBe(true);
      fixture.testButton().click();
      expect(fixture.calls("webSearch.test")).toHaveLength(0);
      if (phase === "rejected") {
        await waitForSolid(() => {
          expect(field.isConnected).toBe(true);
          expect(fixture.input(label)).toBe(field);
          expect(field.disabled).toBe(false);
        });
        expect(fixture.element.textContent).toContain("Synthetic save rejected");
        expect(
          [...fixture.element.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Retry",
          ),
        ).toBe(true);
      }
    } finally {
      if (phase !== "rejected") {
        fixture.save.reject(
          new GatewayRequestError({ code: "INVALID_REQUEST", message: "Synthetic save rejected" }),
        );
        await committed;
      }
    }
  });

  it("invalidates completed health after an external unsaved draft", async () => {
    const fixture = await mount();
    fixture.testButton().click();
    await fixture.settle(true);
    expect(fixture.element.textContent).toContain(testResult.content);

    fixture.runtime.patchForm(endpointPath, "https://draft.example.test");
    flush();
    expect(fixture.element.textContent).not.toContain(testResult.content);
    expect(fixture.testButton().disabled).toBe(true);
  });

  it("waits for activation and refreshes automatically when only the applied revision advances", async () => {
    const fixture = await mount();
    edit(fixture.element, "Search endpoint", "https://next.example.test");
    const committed = fixture.runtime.flushFormChanges();
    const submitted = await fixture.writeStarted.promise;
    const saved = JSON.parse(submitted.raw) as Record<string, unknown>;
    fixture.setStored({
      ...fixture.stored(),
      config: saved,
      sourceConfig: saved,
      raw: submitted.raw,
      hash: "saved-2",
      configRevisionHash: "revision-2",
    });
    fixture.save.resolve({ config: saved, hash: "saved-2" });
    await committed;
    await vi.advanceTimersByTimeAsync(250);
    await fixture.settle();
    expect(fixture.runtime.state).toMatchObject({ configFormDirty: false, configNeedsApply: true });
    expect(fixture.testButton().disabled).toBe(true);
    expect(fixture.element.textContent).toContain("Runtime revision-1");
    const before = fixture.calls("webSearch.status").length;
    const savedHash = fixture.runtime.state.configSnapshot?.hash;
    fixture.setStored({ ...fixture.stored(), appliedConfigHash: "revision-2" });
    await vi.advanceTimersByTimeAsync(750);
    await fixture.settle();
    expect(fixture.runtime.state.configSnapshot?.hash).toBe(savedHash);
    expect(fixture.runtime.state.configNeedsApply).toBe(false);
    expect(fixture.calls("webSearch.status").length).toBeGreaterThan(before);
    expect(fixture.element.textContent).toContain("Runtime revision-2");
    expect(fixture.testButton().disabled).toBe(false);
  });
});
