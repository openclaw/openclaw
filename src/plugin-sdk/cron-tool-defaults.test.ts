import { expect, it } from "vitest";
import { resolveCronToolDefaults } from "./cron-tool-defaults.js";

it("constructs a stable selection for a host approval proposal without mutating its input", () => {
  const toolsAllow = ["execute_code", "read"];
  expect(resolveCronToolDefaults({ toolsAllow, defaultTools: ["read", "web_fetch"] })).toEqual([
    "execute_code",
    "read",
    "web_fetch",
  ]);
  expect(toolsAllow).toEqual(["execute_code", "read"]);
});

it("preserves exact, empty, omitted, and cleared selections for the native owner", () => {
  for (const toolsAllow of [undefined, null, []]) {
    expect(resolveCronToolDefaults({ toolsAllow, defaultTools: ["read"] })).toBe(toolsAllow);
  }
  const toolsAllow = ["execute_code"];
  expect(resolveCronToolDefaults({ toolsAllow, defaultTools: ["read"], mode: "exact" })).toBe(
    toolsAllow,
  );
  expect(resolveCronToolDefaults({ toolsAllow })).toBe(toolsAllow);
});
