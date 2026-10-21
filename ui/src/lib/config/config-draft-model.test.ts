// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import * as json5Runtime from "../json5-runtime.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createGatewayHarness,
  createConfigServerMock,
  createDeferredSetServerMock,
  createConfigCapabilityHarness,
} from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

describe("config draft model", () => {
  it.each([
    { edit: "delete", dispose: false, unavailable: false },
    { edit: "revert", dispose: true, unavailable: true },
  ])(
    "config.set replays $edit (dispose: $dispose, JSON5 unavailable: $unavailable)",
    async ({ edit, dispose, unavailable }) => {
      vi.useFakeTimers();
      const canonical = { count: 2, ui: { prefs: { locale: "fr" } } };
      const { request, submissions, firstSet } = createDeferredSetServerMock(canonical);
      if (unavailable) {
        vi.spyOn(json5Runtime, "parseJson5Text").mockImplementation(JSON.parse);
        vi.spyOn(json5Runtime, "warmJson5").mockRejectedValue(new Error("Chunk unavailable"));
        request.mockResolvedValueOnce({
          config: { count: 1 },
          raw: '// operator comment\n{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      const { runtimeConfig } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      if (edit === "revert") {
        runtimeConfig.patchForm(["count"], 1);
      } else {
        runtimeConfig.removeFormValue(["count"]);
      }
      if (dispose) {
        runtimeConfig.dispose();
      }
      firstSet.resolve({});
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

      expect(submissions).toHaveLength(2);
      expect(submissions[1]?.baseHash).toBe("hash-2");
      expect(submissions.map(({ raw }) => JSON.parse(raw))).toEqual([
        { count: 2 },
        { ...(edit === "revert" ? { count: 1 } : {}), ui: canonical.ui },
      ]);
      if (!dispose) {
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
      }
      runtimeConfig.dispose();
      vi.restoreAllMocks();
    },
  );

  it("config.set adopts its revision and rejects stale raw comments by content", async () => {
    const raw = "{\n  // Keep this note.\n  count: 2,\n}\n";
    vi.useFakeTimers();
    const canonical = { count: 2, ui: { prefs: { locale: "fr" } } };
    const { request, submissions, firstSet } = createDeferredSetServerMock(canonical);
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    runtimeConfig.setRaw(raw);
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(runtimeConfig.state.configRaw).toBe(raw);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    expect(runtimeConfig.state.configSnapshot).toMatchObject({
      config: canonical,
      hash: "hash-2",
    });
    await expect(runtimeConfig.save()).resolves.toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    expect(submissions).toHaveLength(1);
    runtimeConfig.dispose();
  });

  it("config.set retains a redacted object's child deletion during teardown", async () => {
    vi.useFakeTimers();
    const canonical = {
      count: 1,
      channels: { googlechat: { serviceAccount: "__OPENCLAW_REDACTED__" } },
      ui: { prefs: { locale: "fr" } },
    };
    const { request, submissions, firstSet } = createDeferredSetServerMock(canonical);
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    const account = { project_id: "fixture-project", client_email: "before@example.invalid" };
    const path = ["channels", "googlechat", "serviceAccount"];
    runtimeConfig.patchForm(path, account);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    runtimeConfig.removeFormValue([...path, "client_email"]);
    runtimeConfig.dispose();
    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.baseHash).toBe("hash-2");
    expect(submissions.map(({ raw }) => JSON.parse(raw))).toEqual([
      { count: 1, channels: { googlechat: { serviceAccount: account } } },
      {
        ...canonical,
        channels: {
          googlechat: {
            serviceAccount: {
              project_id: "fixture-project",
            },
          },
        },
      },
    ]);
    runtimeConfig.dispose();
  });

  it("config.set serializes schema-coerced form values with the draft base hash", async () => {
    const submitted: Array<{ method: string; params: unknown }> = [];
    let configGetCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        configGetCount += 1;
        return {
          config:
            configGetCount === 1
              ? { count: 1, composedCount: 2, enabled: false, tags: [1], label: "ok" }
              : {},
          hash: configGetCount === 1 ? "hash-1" : "hash-2",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              count: { type: "number" },
              composedCount: { type: "number", allOf: [{ minimum: 2 }] },
              enabled: { type: "boolean" },
              tags: { type: "array", items: { type: "integer" } },
              label: { type: "string", minLength: 1 },
            },
          },
          uiHints: {},
        };
      }
      submitted.push({ method, params });
      return { config: JSON.parse((params as { raw: string }).raw), hash: "hash-2" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
    runtimeConfig.patchForm(["count"], "42.5");
    runtimeConfig.patchForm(["composedCount"], "8.5");
    runtimeConfig.patchForm(["enabled"], "true");
    runtimeConfig.patchForm(["tags"], ["7", ""]);
    runtimeConfig.patchForm(["label"], "");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    const submission = submitted.find((entry) => entry.method === "config.set");
    expect(submission?.params).toMatchObject({ baseHash: "hash-1" });
    const raw = (submission?.params as { raw?: unknown } | undefined)?.raw;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual({
      count: 42.5,
      composedCount: 8.5,
      enabled: true,
      tags: [7],
    });
    runtimeConfig.dispose();
  });

  it("removes a restored optional override from config.set while preserving siblings", async () => {
    const submitted: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          config: { runtime: { keep: true, mode: "custom" } },
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              runtime: {
                type: "object",
                properties: {
                  keep: { type: "boolean" },
                  mode: { type: "string", default: "balanced" },
                },
              },
            },
          },
          uiHints: {},
        };
      }
      submitted.push({ method, params });
      return { config: JSON.parse((params as { raw: string }).raw), hash: "hash-2" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
    runtimeConfig.removeFormValue(["runtime", "mode"]);

    await expect(runtimeConfig.save()).resolves.toBe(true);
    const submission = submitted.find((entry) => entry.method === "config.set");
    const raw = (submission?.params as { raw?: unknown } | undefined)?.raw;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual({ runtime: { keep: true } });
    runtimeConfig.dispose();
  });

  it("config.set submits only decimal numeric spellings as numbers", async () => {
    const submitted: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          config: {},
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              hex: { type: "number" },
              binary: { type: "integer" },
              explicitPlus: { type: "number" },
              separator: { type: "number" },
              nonFinite: { type: "number" },
              scientific: { type: "number" },
              decimal: { type: "number" },
              fractionalInteger: { type: "integer" },
              unionRadix: { anyOf: [{ type: "integer" }, { type: "string" }] },
              unionScientific: { anyOf: [{ type: "integer" }, { type: "string" }] },
              unionDigits: {
                oneOf: [{ type: "integer" }, { type: "string", pattern: "^[0-9]+$" }],
              },
              unionEnum: {
                anyOf: [
                  { type: "number", const: 60 },
                  { type: "string", enum: ["60"] },
                ],
              },
              unionConstOnly: { anyOf: [{ const: "60" }, { type: "number" }] },
              unionEnumOnly: { oneOf: [{ enum: ["60"] }, { type: "number" }] },
              unionBooleanConstOnly: {
                anyOf: [{ const: "true" }, { type: "boolean" }],
              },
            },
          },
          uiHints: {},
        };
      }
      submitted.push({ method, params });
      return { config: JSON.parse((params as { raw: string }).raw), hash: "hash-2" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
    runtimeConfig.patchForm(["hex"], "0x10");
    runtimeConfig.patchForm(["binary"], "0b1010");
    runtimeConfig.patchForm(["explicitPlus"], "+5");
    runtimeConfig.patchForm(["separator"], "1_000");
    runtimeConfig.patchForm(["nonFinite"], "Infinity");
    runtimeConfig.patchForm(["scientific"], "-2.5E-3");
    runtimeConfig.patchForm(["decimal"], ".5");
    runtimeConfig.patchForm(["fractionalInteger"], "42.5");
    runtimeConfig.patchForm(["unionRadix"], "0o17");
    runtimeConfig.patchForm(["unionScientific"], "1e5");
    runtimeConfig.patchForm(["unionDigits"], "00123");
    runtimeConfig.patchForm(["unionEnum"], "60");
    runtimeConfig.patchForm(["unionConstOnly"], "60");
    runtimeConfig.patchForm(["unionEnumOnly"], "60");
    runtimeConfig.patchForm(["unionBooleanConstOnly"], "true");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    const submission = submitted.find((entry) => entry.method === "config.set");
    const raw = (submission?.params as { raw?: unknown } | undefined)?.raw;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual({
      hex: "0x10",
      binary: "0b1010",
      explicitPlus: "+5",
      separator: "1_000",
      nonFinite: "Infinity",
      scientific: -0.0025,
      decimal: 0.5,
      fractionalInteger: "42.5",
      unionRadix: "0o17",
      // String-capable unions keep the text input; the Gateway owns constraints.
      unionScientific: "1e5",
      unionDigits: "00123",
      unionEnum: "60",
      unionConstOnly: "60",
      unionEnumOnly: "60",
      unionBooleanConstOnly: "true",
    });
    runtimeConfig.dispose();
  });

  it("config.set preserves 64-bit id strings through the form submit roundtrip", async () => {
    const submitted: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          config: {
            allowFrom: { discord: ["1048113311314608148", 42] },
            label: "before",
          },
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              allowFrom: {
                type: "object",
                additionalProperties: {
                  type: "array",
                  items: {
                    oneOf: [
                      {
                        type: "string",
                        allOf: [{ pattern: "^[0-9]+$" }],
                        not: { const: "never" },
                      },
                      { type: "number" },
                    ],
                  },
                },
              },
              bigInteger: { type: "integer" },
              label: { type: "string" },
            },
          },
          uiHints: {},
        };
      }
      submitted.push({ method, params });
      return { config: JSON.parse((params as { raw: string }).raw), hash: "hash-2" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
    // Only the unrelated label is edited; the untouched allowFrom entry must
    // come back byte-identical instead of collapsing to Number precision.
    runtimeConfig.patchForm(["label"], "after");
    runtimeConfig.patchForm(["bigInteger"], "10481133113146081487");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    const submission = submitted.find((entry) => entry.method === "config.set");
    const raw = (submission?.params as { raw?: unknown } | undefined)?.raw;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual({
      allowFrom: { discord: ["1048113311314608148", 42] },
      // Beyond 2^53 an unsafe integer parse must not happen even for pure
      // integer fields; the string is kept for the gateway to reject loudly.
      bigInteger: "10481133113146081487",
      label: "after",
    });
    runtimeConfig.dispose();
  });

  it("config.set stages inherited agent overrides and the default through the public capability", async () => {
    const submitted: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          sourceConfig: {
            agents: {
              ownership: "explicit",
              defaults: { systemAgent: { agentId: "reviewer" } },
              entries: {
                MAIN: {},
                reviewer: {},
              },
            },
          },
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      submitted.push({ method, params });
      return { config: JSON.parse((params as { raw: string }).raw), hash: "hash-2" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    const newAgent = runtimeConfig.agentEntry("new-agent", { ensure: true });
    expect(newAgent).toEqual({
      path: ["agents", "entries", "new-agent"],
      entry: {},
    });
    runtimeConfig.patchForm([...newAgent!.path, "model"], "openai/gpt-5.4");
    expect(runtimeConfig.stageDefaultAgent("main")).toBe(true);
    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "MAIN" } },
        entries: {
          MAIN: {},
          reviewer: {},
          "new-agent": { model: "openai/gpt-5.4" },
        },
      },
    });
    await expect(runtimeConfig.save()).resolves.toBe(true);
    const raw = (
      submitted.find((entry) => entry.method === "config.set")?.params as
        | { raw?: unknown }
        | undefined
    )?.raw;
    expect(JSON.parse(String(raw))).toEqual({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "MAIN" } },
        entries: {
          MAIN: {},
          reviewer: {},
          "new-agent": { model: "openai/gpt-5.4" },
        },
      },
    });
    expect(JSON.parse(String(raw)).agents).not.toHaveProperty("list");
    runtimeConfig.dispose();
  });

  it("refuses to create blocked agent entry paths", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            sourceConfig: { agents: { entries: { main: {} } } },
            hash: "hash-1",
            valid: true,
            issues: [],
          }
        : {},
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.agentEntry("__proto__", { ensure: true })).toBeNull();
    expect(runtimeConfig.agentEntry(" ", { ensure: true })).toBeNull();
    expect(runtimeConfig.state.configForm).toEqual({
      agents: { entries: { main: {} } },
    });
    runtimeConfig.dispose();
  });

  it("formats the rejected apply validation path without changing the Gateway issue", async () => {
    const providerId = "a.models.3";
    vi.useFakeTimers();
    const issue = {
      path: `models.providers.${providerId}.models.3.name`,
      message: "Invalid model name",
    };
    const rejection = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: `invalid config: ${issue.path}: ${issue.message}`,
      details: { issues: [issue] },
    });
    const config = {
      models: {
        providers: {
          [providerId]: {
            models: [{ name: "First" }, { name: "Second" }, { name: "Third" }, { name: "Fourth" }],
          },
        },
      },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { config, raw: JSON.stringify(config), hash: "hash-1", valid: true, issues: [] };
      }
      if (method === "config.set" || method === "config.apply") {
        throw rejection;
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    expect(runtimeConfig.state.configSchema).toBeNull();

    await expect(runtimeConfig.apply()).resolves.toBe(false);

    expect(runtimeConfig.state.configSnapshot?.valid).toBe(true);
    expect(runtimeConfig.state.configIssues).toEqual([]);
    expect(runtimeConfig.state.lastError).toBe(
      `GatewayRequestError: invalid config: models.providers.${providerId}.models.#4.name: Invalid model name`,
    );
    expect(issue.path).toBe(`models.providers.${providerId}.models.3.name`);
    expect(rejection.message).toBe(
      `invalid config: models.providers.${providerId}.models.3.name: Invalid model name`,
    );
    expect(rejection.details).toEqual({ issues: [issue] });
    runtimeConfig.dispose();
  });

  it("preserves raw validation paths when dotted draft keys have multiple interpretations", async () => {
    const issue = {
      path: "models.providers.a.models.3.name",
      message: "Invalid model name",
    };
    const config = {
      models: {
        providers: {
          a: {
            models: [{ name: "First" }, { name: "Second" }, { name: "Third" }, { name: "Fourth" }],
          },
          "a.models.3.name": { models: [{ name: "Ambiguous provider" }] },
        },
      },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { config, raw: JSON.stringify(config), hash: "hash-1", valid: true, issues: [] };
      }
      if (method === "config.set") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: `invalid config: ${issue.path}: ${issue.message}`,
          details: { issues: [issue] },
        });
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["models", "providers", "a", "models", 3, "name"], "");

    await expect(runtimeConfig.save()).resolves.toBe(false);
    expect(runtimeConfig.state.lastError).toBe(
      "GatewayRequestError: invalid config: models.providers.a.models.3.name: Invalid model name",
    );
    expect(issue.path).toBe("models.providers.a.models.3.name");
    runtimeConfig.dispose();
  });

  it("rewrites only complete validation fields when issue paths overlap", async () => {
    const issues = [
      { path: "foo.items.0.name", message: "Invalid numeric record" },
      { path: "items.0.name", message: "Invalid array item" },
    ];
    const config = {
      foo: { items: { "0": { name: "Record" } } },
      items: [{ name: "Array" }],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { config, raw: JSON.stringify(config), hash: "hash-1", valid: true, issues: [] };
      }
      if (method === "config.set") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message:
            "invalid config: foo.items.0.name: Invalid numeric record; items.0.name: Invalid array item",
          details: { issues },
        });
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["items", 0, "name"], "");

    await expect(runtimeConfig.save()).resolves.toBe(false);
    expect(runtimeConfig.state.lastError).toBe(
      "GatewayRequestError: invalid config: foo.items.0.name: Invalid numeric record; items.#1.name: Invalid array item",
    );
    expect(issues.map((issue) => issue.path)).toEqual(["foo.items.0.name", "items.0.name"]);
    runtimeConfig.dispose();
  });

  it("formats rejected apply paths against the submitted draft after a mid-flight edit", async () => {
    vi.useFakeTimers();
    const pendingWrite = deferred<unknown>();
    const issue = {
      path: "models.providers.a.models.3.models.3.name",
      message: "Invalid model name",
    };
    const config = {
      models: {
        providers: {
          "a.models.3": {
            models: [{ name: "First" }, { name: "Second" }, { name: "Third" }, { name: "Fourth" }],
          },
        },
      },
    };
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config,
          raw: JSON.stringify(config),
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set" || method === "config.apply") {
        return pendingWrite.promise;
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const write = runtimeConfig.apply();
    expect(request).toHaveBeenCalledWith("config.apply", expect.any(Object));

    runtimeConfig.patchForm(["models", "providers", "a"], {
      models: [{}, {}, {}, { models: [{}, {}, {}, { name: "Overlapping provider" }] }],
    });
    pendingWrite.reject(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: `invalid config: ${issue.path}: ${issue.message}`,
        details: { issues: [issue] },
      }),
    );
    await expect(write).resolves.toBe(false);

    expect(runtimeConfig.state.lastError).toBe(
      "GatewayRequestError: invalid config: models.providers.a.models.3.models.#4.name: Invalid model name",
    );
    runtimeConfig.dispose();
  });

  it("refuses form patches while an unparseable raw draft is pending", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    const brokenRaw = '{\n  "count": broken';
    runtimeConfig.setRaw(brokenRaw);
    runtimeConfig.patchForm(["count"], 7);

    // The raw draft stays authoritative; the form edit is rejected loudly.
    expect(runtimeConfig.state.configRaw).toBe(brokenRaw);
    expect(runtimeConfig.state.configFormMode).toBe("raw");
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.lastError).toContain("Raw editor");
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    runtimeConfig.dispose();
  });

  it("clears a failure when raw editing reverts the draft clean", async () => {
    vi.useFakeTimers();
    let setCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        setCalls += 1;
        throw new Error("disk full");
      }
      return {};
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");

    // Reverting to the original makes the failure moot.
    runtimeConfig.setRaw(runtimeConfig.state.configRawOriginal);
    expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(runtimeConfig.state.lastError).toBeNull();
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(setCalls).toBe(1);
    runtimeConfig.dispose();
  });

  it("refuses apply while a raw draft is dirty", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setRaw('{\n  "count": 9\n}\n');
    await expect(runtimeConfig.apply()).resolves.toBe(false);

    // Raw stays explicit-save-only: nothing was written, the user is told to
    // resolve the raw draft first.
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.lastError).toContain("Raw editor");
    runtimeConfig.dispose();
  });
});
