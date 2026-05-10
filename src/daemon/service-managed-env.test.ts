import { describe, expect, it } from "vitest";
import { readOperatorInheritedEnvAllowlist } from "./service-managed-env.js";

describe("readOperatorInheritedEnvAllowlist", () => {
  it("returns an empty Set when OPENCLAW_SERVICE_MANAGED_ENV_KEYS is absent", () => {
    const allowlist = readOperatorInheritedEnvAllowlist({});
    expect(allowlist).toBeInstanceOf(Set);
    expect(allowlist.size).toBe(0);
  });

  it("parses comma-separated keys and uppercases them", () => {
    const allowlist = readOperatorInheritedEnvAllowlist({
      OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "gh_token, AWS_ACCESS_KEY_ID ,NpM_ToKeN",
    });
    expect(allowlist.has("GH_TOKEN")).toBe(true);
    expect(allowlist.has("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(allowlist.has("NPM_TOKEN")).toBe(true);
  });

  it("excludes OPENCLAW_* keys (internal gateway secrets are never inherited)", () => {
    const allowlist = readOperatorInheritedEnvAllowlist({
      OPENCLAW_SERVICE_MANAGED_ENV_KEYS:
        "GH_TOKEN,OPENCLAW_GATEWAY_TOKEN,OPENCLAW_GATEWAY_PASSWORD,OPENCLAW_PORT",
    });
    expect(allowlist.has("GH_TOKEN")).toBe(true);
    expect(allowlist.has("OPENCLAW_GATEWAY_TOKEN")).toBe(false);
    expect(allowlist.has("OPENCLAW_GATEWAY_PASSWORD")).toBe(false);
    expect(allowlist.has("OPENCLAW_PORT")).toBe(false);
  });

  it("defensively excludes everywhere-dangerous keys even if listed", () => {
    const allowlist = readOperatorInheritedEnvAllowlist({
      OPENCLAW_SERVICE_MANAGED_ENV_KEYS:
        "GH_TOKEN,LD_PRELOAD,NODE_OPTIONS,BASH_ENV,DYLD_INSERT_LIBRARIES",
    });
    expect(allowlist.has("GH_TOKEN")).toBe(true);
    expect(allowlist.has("LD_PRELOAD")).toBe(false);
    expect(allowlist.has("NODE_OPTIONS")).toBe(false);
    expect(allowlist.has("BASH_ENV")).toBe(false);
    expect(allowlist.has("DYLD_INSERT_LIBRARIES")).toBe(false);
  });
});
