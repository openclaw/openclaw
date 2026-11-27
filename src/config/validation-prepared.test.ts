import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  preparePluginSchemaValidations,
  validatePreparedPluginSchemaValue,
} from "./validation-prepared.js";

it("retains one private copy when validation returns the original input", () => {
  const prepared = preparePluginSchemaValidations();
  const params = {
    cacheKey: "test-plugin",
    origin: "bundled" as const,
    schema: { type: "object" },
    value: { labels: ["first"] },
    applyDefaults: true,
  };
  const miss = validatePreparedPluginSchemaValue(params, prepared);
  expect(miss.ok && miss.value).toBe(params.value);
  const entry = expectDefined(prepared.next.peek(params.cacheKey), "cached validation");
  expect(entry.result.ok && entry.result.value).toBe(entry.input);
  expect(entry.input).not.toBe(params.value);

  params.value.labels.push("changed");
  expect(entry.input).toEqual({ labels: ["first"] });
  const hit = validatePreparedPluginSchemaValue(
    { ...params, value: { labels: ["first"] } },
    prepared,
  );
  expect(hit).toEqual({ ok: true, value: { labels: ["first"] } });
  expect(hit.ok && hit.value).not.toBe(entry.input);
});
