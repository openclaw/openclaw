import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSearchTestResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  atPath,
  mountSearch,
  providerPath as pathForProvider,
  searchPath,
  searchStatus,
} from "./search-page.test-support.tsx";

const providerPath = pathForProvider("example");
const endpointPath = [...providerPath, "baseUrl"];
const config = {
  ...atPath([...searchPath, "provider"], "example"),
  ...atPath(providerPath, {
    baseUrl: "https://initial.example.test",
    apiKey: "synthetic-original-key",
  }),
};
const ready = searchStatus(
  "example",
  "Example Search",
  {
    hint: "Synthetic provider",
    requiresCredential: true,
    credentialSource: "config",
    credential: { path: [...providerPath, "apiKey"], label: "Example API key", envVars: [] },
  },
  { provider: "example", model: { provider: "example", id: "local", runtime: "openclaw" } },
);
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
        ? schemaAt(searchPath, {
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
    "webSearch.status": async () => ({
      ...ready,
      route: { ...ready.route, label: `Runtime ${stored.appliedConfigHash}` },
    }),
    "webSearch.test": () => searchResponse,
  };
  const fixture = await mountSearch({
    respond: (method, params) => {
      const respond = Object.hasOwn(responses, method) ? responses[method] : undefined;
      if (!respond) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return respond(params);
    },
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
    ...fixture,
    testButton: () => fixture.button("Test search"),
    save,
    rejectSave: () =>
      save.reject(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Synthetic save rejected" }),
      ),
    writeStarted,
    setStored: (snapshot: ConfigSnapshot) => {
      stored = snapshot;
    },
    stored: () => stored,
  };
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
    fixture.edit(label, value, false);

    fixture.replaceConnection();
    await fixture.settle();
    const current = fixture.input(label);
    expect(current).toMatchObject({ disabled: false });
    expect(current).not.toBe(field);
    expect(field.isConnected).toBe(false);
    field.dispatchEvent(new FocusEvent("blur"));
    await fixture.settle();
    expect(fixture.calls("config.set")).toHaveLength(0);
    expect(fixture.runtime.state.configFormDirty).toBe(false);

    if (label === "Result limit") {
      fixture.element.querySelector<HTMLDetailsElement>("details")!.open = true;
    }
    fixture.edit(label, value);
    const submitted = await fixture.writeStarted.promise;
    expect(submitted.baseHash).toBe("saved-1");
    const expected =
      label === "Search endpoint"
        ? atPath(endpointPath, value)
        : atPath([...searchPath, "maxResults"], Number(value));
    expect(JSON.parse(submitted.raw)).toMatchObject(expected);
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
    const field = fixture.edit(label, "synthetic-replacement");
    const committed = fixture.runtime.flushFormChanges();
    await fixture.writeStarted.promise;
    if (phase === "pending reverted") {
      fixture.runtime.patchForm(endpointPath, "https://initial.example.test");
    }
    if (phase === "rejected") {
      fixture.rejectSave();
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
          expect(field).toMatchObject({ isConnected: true, disabled: false });
          expect(fixture.input(label)).toBe(field);
        });
        expect(fixture.element.textContent).toContain("Synthetic save rejected");
        expect(fixture.button("Retry")).toBeDefined();
      }
    } finally {
      if (phase !== "rejected") {
        fixture.rejectSave();
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
    fixture.edit("Search endpoint", "https://next.example.test");
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
