import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeSnapshot from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { invalidateConfigGetResponseCache, readConfigGetResponse } from "./config-get-response.js";

type DiagnosticSnapshot = Omit<ConfigFileSnapshot, "sourceConfig">;

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
  it.each([true, false])("does not hash invalid config (exists: %s)", async (exists) => {
    const issues = [{ path: "<root>", message: "JSON parse failed" }];
    readSnapshot.mockResolvedValue({
      path: "/synthetic/openclaw.json",
      exists,
      valid: false,
      raw: exists ? "{ invalid config" : null,
      parsed: null,
      resolved: {},
      runtimeConfig: {},
      config: {},
      hash: exists ? "diagnostic-revision" : undefined,
      issues,
      warnings: [],
      legacyIssues: [],
    });
    const hash = vi.spyOn(runtimeSnapshot, "hashRuntimeConfigValue");

    const response = await readConfigGetResponse({
      loadUiHints: () => undefined,
      revisionProjector: {
        projectRawHash: (value) => `raw:${value}`,
        projectResolvedHash: (value) => `resolved:${value}`,
        hashResponseSessionBearer: () => "unused-test-scope",
      },
    });

    expect(response).toMatchObject({
      exists,
      valid: false,
      raw: null,
      configRevisionHash: null,
      appliedConfigHash: "resolved:serving-revision",
      issues,
    });
    expect(response.hash).toBe(exists ? "raw:diagnostic-revision" : undefined);
    expect(hash).not.toHaveBeenCalled();
  });
});
