import { describe, expect, it } from "vitest";
import { resolveConfigForRead } from "./io.read-helpers.js";
import {
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import { describeConfigSnapshotInputChange } from "./snapshot-inputs.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const snapshot: ConfigFileSnapshot = {
  path: "/config/openclaw.json",
  exists: true,
  valid: true,
  raw: '{ gateway: { port: "${PORT}" } }',
  parsed: { gateway: { port: "${PORT}" } },
  sourceConfig: { gateway: { port: 18789 } },
  resolved: { gateway: { port: 18789 } },
  runtimeConfig: { gateway: { port: 18789 } },
  config: { gateway: { port: 18789 } },
  hash: "root-and-include-revision",
  issues: [],
  warnings: [],
  legacyIssues: [],
};

describe("config snapshot input identity", () => {
  function resolveTokenSnapshot(env: NodeJS.ProcessEnv): ConfigFileSnapshot {
    const parsed = { gateway: { auth: { token: "${TOKEN}" } } };
    const { resolvedConfigRaw, resolutionFacts } = resolveConfigForRead(parsed, env);
    const sourceConfig = resolvedConfigRaw as OpenClawConfig;
    setConfigResolutionFacts(sourceConfig, resolutionFacts);
    return {
      ...snapshot,
      raw: JSON.stringify(parsed),
      parsed,
      sourceConfig,
      resolved: sourceConfig,
      runtimeConfig: sourceConfig,
      config: sourceConfig,
    };
  }

  it.each([
    [{ path: "/config/other.json" }, "config file path changed"],
    [{ exists: false }, "config file was created or removed"],
    [{ raw: "{}", hash: "changed" }, "authored config file contents changed"],
    [{ hash: "changed-include" }, "included config contents or targets changed"],
    [{ sourceConfig: { gateway: { port: 18790 } } }, "resolved config values changed"],
    [{ valid: false, runtimeConfig: {}, config: {} }, undefined],
  ] satisfies [Partial<ConfigFileSnapshot>, string | undefined][])(
    "compares %j",
    (change, reason) => {
      expect(describeConfigSnapshotInputChange(snapshot, { ...snapshot, ...change })).toBe(reason);
    },
  );

  it.each([undefined, "${TOKEN}"])("compares same-text resolution with TOKEN=%s", (TOKEN) => {
    const before = resolveTokenSnapshot({});
    const after = resolveTokenSnapshot({ TOKEN });
    expect(after.sourceConfig).toEqual(before.sourceConfig);
    expect(getConfigResolutionFacts(after.sourceConfig)).not.toBe(
      getConfigResolutionFacts(before.sourceConfig),
    );
    expect(getAuthoredConfigSecretRef(before.sourceConfig, "gateway.auth.token")).toEqual({
      source: "env",
      provider: "default",
      id: "TOKEN",
    });
    expect(getAuthoredConfigSecretRef(after.sourceConfig, "gateway.auth.token")).toEqual(
      TOKEN === undefined ? { source: "env", provider: "default", id: "TOKEN" } : null,
    );
    expect(describeConfigSnapshotInputChange(before, after)).toBe(
      TOKEN === undefined ? undefined : "resolved config provenance changed",
    );
    expect(
      describeConfigSnapshotInputChange(before, after, { compareResolvedConfig: false }),
    ).toBeUndefined();
  });
});
