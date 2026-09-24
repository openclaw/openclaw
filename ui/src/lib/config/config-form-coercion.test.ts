// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness } from "./config-test-harness.ts";
import { createRuntimeConfigCapability } from "./runtime-config-capability.ts";

it("config.set coerces edits while preserving untouched source values and the draft base hash", async () => {
  const submitted: Array<{ method: string; params: unknown }> = [];
  const saved = {
    count: 1,
    composedCount: 2,
    enabled: false,
    tags: [1],
    label: "ok",
    optional: { enabled: "false", count: "12", label: "", secret: "${OPTIONAL_SECRET}" },
    rows: [
      { enabled: false, labels: ["ok"], name: "remove" },
      { enabled: "true", labels: [""], name: "before" },
    ],
    retainedLabels: ["remove", ""],
    keyedFlags: { "123": "false" },
    pluginOwned: { future: { enabled: "false" } },
  };
  let configGetCount = 0;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      configGetCount += 1;
      return {
        config:
          configGetCount === 1
            ? { count: 1, composedCount: 2, enabled: false, tags: [1], label: "ok" }
            : {},
        sourceConfig: configGetCount === 1 ? saved : {},
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
            optional: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                count: { type: "integer" },
                label: { type: "string", minLength: 1 },
                secret: { type: "string" },
              },
            },
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  labels: { type: "array", items: { type: "string", minLength: 1 } },
                  name: { type: "string" },
                },
              },
            },
            retainedLabels: { type: "array", items: { type: "string", minLength: 1 } },
            keyedFlags: { type: "object", additionalProperties: { type: "boolean" } },
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
  runtimeConfig.removeFormValue(["rows", 0]);
  runtimeConfig.patchForm(["rows", 0, "name"], "after");
  runtimeConfig.removeFormValue(["retainedLabels", 0]);

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
    optional: saved.optional,
    rows: [{ enabled: "true", labels: [""], name: "after" }],
    retainedLabels: [""],
    keyedFlags: saved.keyedFlags,
    pluginOwned: saved.pluginOwned,
  });
  runtimeConfig.dispose();
});
