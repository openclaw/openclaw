import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
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
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { PluginCredentialEditor } from "../plugins/credential-editor.ts";
import "./search-page.ts";

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
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function mount() {
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
  let searchResponse = Promise.resolve(testResult);
  const reads: Promise<unknown>[] = [];
  const tests: Promise<unknown>[] = [];
  const request = createGatewayRequestMock((method, params) => {
    let response: Promise<unknown>;
    switch (method) {
      case "config.get":
        response = Promise.resolve(structuredClone(stored));
        break;
      case "config.schema":
        response = Promise.resolve({
          schema: providerPath.reduceRight<unknown>(
            (child, key) => ({ type: "object", properties: { [key]: child } }),
            {
              type: "object",
              properties: {
                baseUrl: { type: "string", title: "Search endpoint" },
                apiKey: { type: "string", title: "Example API key" },
              },
            },
          ),
          uiHints: {},
          version: "test-1",
          generatedAt: "",
        });
        break;
      case "config.set":
        writeStarted.resolve(params as { raw: string; baseHash: string });
        response = save.promise;
        break;
      case "models.list":
        response = Promise.resolve({ models: [] });
        break;
      case "plugins.credentials.inspect":
        response = Promise.resolve({ baseHash: stored.hash, credential: { kind: "literal" } });
        break;
      case "webSearch.status":
        response = Promise.resolve({
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
        } satisfies WebSearchStatusResult);
        break;
      case "webSearch.test":
        response = searchResponse;
        tests.push(response);
        break;
      default:
        throw new Error(`Unexpected request: ${method}`);
    }
    if (method !== "config.set" && method !== "webSearch.test") {
      reads.push(response);
    }
    return response;
  });
  const client = createTestGatewayClient(request);
  const { gateway } = createApplicationGateway({
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
  const host = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-search-page") as OpenClawLightDomElement;
  host.append(element);
  document.body.append(host);
  onTestFinished(() => {
    element.remove();
    runtime.dispose();
  });
  const settle = async (includeTests = false) => {
    await element.updateComplete;
    await settleModelCatalogRequests(client, { agentId: "main" });
    await Promise.allSettled(reads);
    if (includeTests) {
      await Promise.allSettled(tests);
    }
    await element.updateComplete;
  };
  await settle();
  return {
    element,
    runtime,
    request,
    save,
    writeStarted,
    settle,
    setTestResponse: (response: Promise<WebSearchTestResult>) => {
      searchResponse = response;
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
    { label: "Search endpoint", phase: "pending" },
    { label: "Search endpoint", phase: "rejected" },
    { label: "Search endpoint", phase: "pending reverted" },
    { label: "Example API key", phase: "pending" },
    { label: "Example API key", phase: "rejected" },
  ])("blocks tests for a $phase $label save while allowing repair", async ({ label, phase }) => {
    const fixture = await mount();
    const credential =
      label === "Example API key"
        ? fixture.element.querySelector<PluginCredentialEditor>(
            "openclaw-plugin-credential-editor",
          )!
        : null;
    const commit = credential ? vi.spyOn(credential.context, "onCommit") : null;
    const field = edit(fixture.element, label, "synthetic-replacement");
    const committed: Promise<boolean> =
      commit?.mock.results[0]?.value ?? fixture.runtime.flushFormChanges();
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
    await fixture.element.updateComplete;
    await credential?.updateComplete;
    try {
      expect(fixture.runtime.state.configSaving).toBe(false);
      expect(fixture.runtime.state.configFormDirty).toBe(phase !== "pending reverted");
      expect(fixture.runtime.state.configAutoSaveStatus).toBe(
        phase === "rejected" ? "error" : "saving",
      );
      expect(testButton(fixture.element).disabled).toBe(true);
      testButton(fixture.element).click();
      expect(fixture.request.mock.calls.some(([method]) => method === "webSearch.test")).toBe(
        false,
      );
      if (phase === "rejected") {
        expect(field.disabled).toBe(false);
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

  it("cannot revive a pending health result after an external draft edit is discarded", async () => {
    const fixture = await mount();
    const pending = createDeferred<WebSearchTestResult>();
    fixture.setTestResponse(pending.promise);
    testButton(fixture.element).click();
    await fixture.element.updateComplete;
    fixture.runtime.patchForm(endpointPath, "https://draft.example.test");
    await fixture.element.updateComplete;
    await fixture.runtime.discardDraft();
    expect(fixture.runtime.state.configFormDirty).toBe(false);
    pending.resolve(testResult);
    await fixture.settle(true);
    expect(fixture.element.textContent).not.toContain(testResult.content);
    expect(fixture.element.textContent).toContain("Not tested");
  });

  it("clears completed health when the config owner acquires an unsaved draft", async () => {
    const fixture = await mount();
    testButton(fixture.element).click();
    await fixture.settle(true);
    expect(fixture.element.textContent).toContain(testResult.content);
    fixture.runtime.patchForm(endpointPath, "https://draft.example.test");
    await fixture.element.updateComplete;
    expect(fixture.element.textContent).not.toContain(testResult.content);
    expect(testButton(fixture.element).disabled).toBe(true);
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
    expect(fixture.runtime.state.configFormDirty).toBe(false);
    expect(fixture.runtime.state.configNeedsApply).toBe(true);
    expect(testButton(fixture.element).disabled).toBe(true);
    expect(fixture.element.textContent).toContain("Runtime revision-1");
    const before = fixture.request.mock.calls.filter(
      ([method]) => method === "webSearch.status",
    ).length;
    const savedHash = fixture.runtime.state.configSnapshot?.hash;
    fixture.setStored({ ...fixture.stored(), appliedConfigHash: "revision-2" });
    await vi.advanceTimersByTimeAsync(750);
    await fixture.settle();
    expect(fixture.runtime.state.configSnapshot?.hash).toBe(savedHash);
    expect(fixture.runtime.state.configNeedsApply).toBe(false);
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "webSearch.status").length,
    ).toBeGreaterThan(before);
    expect(fixture.element.textContent).toContain("Runtime revision-2");
    expect(testButton(fixture.element).disabled).toBe(false);
  });
  it("rejects in-flight health when an applied revision changes under the same saved hash", async () => {
    const fixture = await mount();
    const pending = createDeferred<WebSearchTestResult>();
    fixture.setTestResponse(pending.promise);
    testButton(fixture.element).click();
    await fixture.element.updateComplete;
    fixture.setStored({
      ...fixture.stored(),
      configRevisionHash: "revision-2",
      appliedConfigHash: "revision-2",
    });
    await fixture.runtime.refresh({ background: true });
    pending.resolve(testResult);
    await fixture.settle(true);
    expect(fixture.runtime.state.configSnapshot?.hash).toBe("saved-1");
    expect(fixture.element.textContent).not.toContain(testResult.content);
    expect(fixture.element.textContent).toContain("Runtime revision-2");
  });
});
