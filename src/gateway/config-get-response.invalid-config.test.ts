import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeSnapshot from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { invalidateConfigGetResponseCache, readConfigGetResponse } from "./config-get-response.js";

type DiagnosticSnapshot = Omit<ConfigFileSnapshot, "sourceConfig"> & {
  sourceConfig?: null | string;
};

const readSnapshot = vi.hoisted(() => vi.fn<() => Promise<DiagnosticSnapshot>>());
vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: readSnapshot }));
vi.mock("../plugins/runtime.js", () => ({ getActivePluginRegistryVersion: () => 1 }));

beforeEach(() => {
  invalidateConfigGetResponseCache();
  readSnapshot.mockReset();
  runtimeSnapshot.setRuntimeConfigAppliedHash("serving-revision");
});
afterEach(() => {
  vi.restoreAllMocks();
  invalidateConfigGetResponseCache();
  runtimeSnapshot.setRuntimeConfigAppliedHash(null);
});

describe("config.get diagnostic revisions", () => {
  it.each([
    { name: "absent source", source: {}, exists: true, valid: false },
    { name: "null source", source: { sourceConfig: null }, exists: true, valid: false },
    { name: "non-object source", source: { sourceConfig: "invalid" }, exists: true, valid: false },
    { name: "absent config", source: {}, exists: false, valid: false },
  ])("returns $name without entering valid-config hashing", async ({ source, exists, valid }) => {
    const issues = valid ? [] : [{ path: "<root>", message: "JSON parse failed" }];
    readSnapshot.mockResolvedValue({
      path: "/synthetic/openclaw.json",
      exists,
      valid,
      raw: exists ? "{ invalid config" : null,
      parsed: null,
      resolved: {},
      runtimeConfig: {},
      config: {},
      hash: exists ? "diagnostic-revision" : undefined,
      issues,
      warnings: [],
      legacyIssues: [],
      ...source,
    });
    const hash = vi.spyOn(runtimeSnapshot, "hashRuntimeConfigValue");

    const response = await readConfigGetResponse({
      loadUiHints: () => undefined,
      revisionProjector: {
        projectRawHash: (value) => `raw:${value}`,
        projectResolvedHash: (value) => `resolved:${value}`,
      },
    });

    expect(response).toMatchObject({
      exists,
      valid,
      raw: null,
      configRevisionHash: null,
      appliedConfigHash: "resolved:serving-revision",
      issues,
    });
    expect(response.hash).toBe(exists ? "raw:diagnostic-revision" : undefined);
    expect(hash).not.toHaveBeenCalled();
  });
});
