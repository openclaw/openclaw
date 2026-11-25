import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  WebSearchStatusResultSchema,
  WebSearchTestResultSchema,
} from "../../packages/gateway-protocol/src/schema/web-search.ts";
import { buildSearchMocks } from "../../scripts/control-ui-mock-search.ts";

describe("buildSearchMocks", () => {
  it("answers the Search page with the Gateway's own contract", () => {
    const mocks = buildSearchMocks("mock-hash");

    expect(Value.Check(WebSearchStatusResultSchema, mocks["webSearch.status"])).toBe(true);
    expect(Value.Check(WebSearchTestResultSchema, mocks["webSearch.test"])).toBe(true);
  });
});
