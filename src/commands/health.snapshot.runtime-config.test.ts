// Runtime-config drift health tests (#89526). Split out of health.snapshot.test.ts
// so the drift builder is exercised directly against a config.js mock instead of
// the full getHealthSnapshot harness, keeping both files under the max-lines gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testDiskSourceConfig: Record<string, unknown> | null = null;
let testDiskSnapshotExists: boolean | null = null;
let testDiskSnapshotValid: boolean | null = null;
let testRuntimeSourceConfig: Record<string, unknown> | null = null;
let testRuntimeConfigSnapshotMetadata: {
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  updatedAtMs: number;
} | null = null;

function stableTestConfigStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableTestConfigStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableTestConfigStringify(record[key])}`)
    .join(",")}}`;
}

let buildRuntimeConfigHealth: typeof import("./health.js").buildRuntimeConfigHealth;

async function loadFreshHealthDriftModule() {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfigSourceSnapshot: () => testRuntimeSourceConfig,
    getRuntimeConfigSnapshotMetadata: () => testRuntimeConfigSnapshotMetadata,
    hashRuntimeConfigValue: (config: Record<string, unknown>) =>
      `test:${stableTestConfigStringify(config)}`,
    readSourceConfigSnapshot: async () => {
      if (testDiskSnapshotExists === false) {
        return {
          path: "/tmp/openclaw.json",
          exists: false,
          raw: null,
          parsed: null,
          sourceConfig: {} as Record<string, unknown>,
          resolved: {} as Record<string, unknown>,
          valid: true,
          runtimeConfig: {} as Record<string, unknown>,
          config: {} as Record<string, unknown>,
          issues: [],
          warnings: [],
          legacyIssues: [],
        };
      }
      if (testDiskSnapshotValid === false) {
        return {
          path: "/tmp/openclaw.json",
          exists: true,
          raw: "{invalid",
          parsed: null,
          sourceConfig: {} as Record<string, unknown>,
          resolved: {} as Record<string, unknown>,
          valid: false,
          runtimeConfig: {} as Record<string, unknown>,
          config: {} as Record<string, unknown>,
          issues: [
            { path: "", message: "JSON5 parse error: unexpected token", code: "PARSE_ERROR" },
          ],
          warnings: [],
          legacyIssues: [],
        };
      }
      const source = testDiskSourceConfig ?? testRuntimeSourceConfig ?? {};
      return {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: JSON.stringify(source),
        parsed: source,
        sourceConfig: source,
        resolved: source,
        valid: true,
        runtimeConfig: source,
        config: source,
        issues: [],
        warnings: [],
        legacyIssues: [],
      };
    },
  }));
  vi.resetModules();
  ({ buildRuntimeConfigHealth } = await import("./health.js"));
}

describe("buildRuntimeConfigHealth drift", () => {
  beforeEach(async () => {
    testDiskSourceConfig = null;
    testDiskSnapshotExists = null;
    testDiskSnapshotValid = null;
    testRuntimeSourceConfig = null;
    testRuntimeConfigSnapshotMetadata = null;
    vi.resetModules();
    vi.doUnmock("../config/config.js");
    await loadFreshHealthDriftModule();
  });

  afterEach(() => {
    vi.doUnmock("../config/config.js");
    vi.resetModules();
  });

  it("surfaces model/provider runtime config drift between live gateway and disk in sensitive snapshots", async () => {
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai-codex/gpt-5.5" } },
    };
    testDiskSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 7,
      fingerprint: "runtime-fingerprint",
      sourceFingerprint: "live-source-fingerprint",
      updatedAtMs: 123,
    };

    const runtimeConfig = await buildRuntimeConfigHealth({ includeFingerprints: true });

    expect(runtimeConfig).toEqual({
      state: "drift",
      liveSourceFingerprint: "live-source-fingerprint",
      diskSourceFingerprint: `test:${stableTestConfigStringify(testDiskSourceConfig)}`,
      liveDefaultModel: "openai-codex/gpt-5.5",
      diskDefaultModel: "openai/gpt-5.5",
      driftPaths: ["agents.defaults.model"],
      message:
        "Live gateway runtime config differs from disk for model/provider/auth paths; restart is required or pending.",
    });
  });

  it("omits runtime config fingerprints from non-sensitive snapshots used by cache/broadcast paths", async () => {
    // Regression for the credential-boundary concern raised in #89526 review:
    // the runtime-config fingerprints must stay inside the gateway-auth
    // boundary, so the non-sensitive snapshot should still report drift state +
    // paths + default-model labels but must omit the fingerprints.
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai-codex/gpt-5.5" } },
    };
    testDiskSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 7,
      fingerprint: "runtime-fingerprint",
      sourceFingerprint: "live-source-fingerprint",
      updatedAtMs: 123,
    };

    const runtimeConfig = await buildRuntimeConfigHealth({ includeFingerprints: false });

    expect(runtimeConfig?.state).toBe("drift");
    expect(runtimeConfig?.driftPaths).toEqual(["agents.defaults.model"]);
    expect(runtimeConfig?.liveDefaultModel).toBe("openai-codex/gpt-5.5");
    expect(runtimeConfig?.diskDefaultModel).toBe("openai/gpt-5.5");
    expect(runtimeConfig).not.toHaveProperty("liveSourceFingerprint");
    expect(runtimeConfig).not.toHaveProperty("diskSourceFingerprint");
  });

  it("detects drift on top-level auth.profiles when provider-auth rotates on disk", async () => {
    // Provider-auth repairs touch `auth.profiles` (named provider profile
    // config) rather than the gateway access auth under `gateway.auth.*`.
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      auth: { profiles: { primary: { provider: "openai", mode: "token" } } },
    };
    testDiskSourceConfig = {
      session: { store: "/tmp/x" },
      auth: { profiles: { primary: { provider: "openai", mode: "chatgpt" } } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 8,
      fingerprint: "runtime-fingerprint-auth",
      sourceFingerprint: "live-source-fingerprint-auth",
      updatedAtMs: 234,
    };

    const runtimeConfig = await buildRuntimeConfigHealth({ includeFingerprints: true });

    expect(runtimeConfig?.state).toBe("drift");
    expect(runtimeConfig?.driftPaths).toEqual(["auth.profiles"]);
  });

  it("reports state: unknown with diskReadError when the disk config file is missing", async () => {
    // ClawSweeper P2 on #89526: the previous implementation used
    // `readSourceConfigBestEffort()` which returns `{}` for missing configs and
    // then reported a false "drift". The new reader treats `!exists` as unknown.
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 9,
      fingerprint: "runtime-fingerprint-missing",
      sourceFingerprint: "live-source-fingerprint-missing",
      updatedAtMs: 345,
    };
    testDiskSnapshotExists = false;

    const runtimeConfig = await buildRuntimeConfigHealth({ includeFingerprints: true });

    expect(runtimeConfig?.state).toBe("unknown");
    expect(runtimeConfig?.driftPaths).toBeUndefined();
    expect(runtimeConfig?.message).toMatch(/not found/i);
  });

  it("reports state: unknown with diskReadError when the disk config is invalid", async () => {
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 10,
      fingerprint: "runtime-fingerprint-invalid",
      sourceFingerprint: "live-source-fingerprint-invalid",
      updatedAtMs: 456,
    };
    testDiskSnapshotValid = false;

    const runtimeConfig = await buildRuntimeConfigHealth({ includeFingerprints: true });

    expect(runtimeConfig?.state).toBe("unknown");
    expect(runtimeConfig?.driftPaths).toBeUndefined();
    expect(runtimeConfig?.message).toMatch(/invalid/i);
  });

  it("redacts disk-read error details from non-sensitive runtime config snapshots", async () => {
    // ClawSweeper P1 re-review on #89526: the detailed disk-read error can leak
    // the local config path or a JSON parse excerpt. `openclaw health` runs at
    // `operator.read`, so non-admin callers get the generic message.
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 11,
      fingerprint: "runtime-fingerprint-redact",
      sourceFingerprint: "live-source-fingerprint-redact",
      updatedAtMs: 567,
    };
    testDiskSnapshotValid = false;

    const nonSensitive = await buildRuntimeConfigHealth({ includeFingerprints: false });
    expect(nonSensitive?.state).toBe("unknown");
    expect(nonSensitive?.message).toBe("Disk config source snapshot is unavailable.");
    expect(nonSensitive?.liveSourceFingerprint).toBeUndefined();

    const sensitive = await buildRuntimeConfigHealth({ includeFingerprints: true });
    expect(sensitive?.state).toBe("unknown");
    expect(sensitive?.message).toMatch(/Could not read disk config source snapshot/);
    expect(sensitive?.liveSourceFingerprint).toBeDefined();
  });
});
