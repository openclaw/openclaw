import { afterEach, expect, it, vi } from "vitest";
import {
  collectRuntimeCapabilities,
  formatRuntimeCapabilities,
  observeRuntimeProfileCapability,
} from "./runtime-capabilities.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("reports the executing AOT image and configured restrictions without probing optional features", () => {
  vi.stubGlobal("__openclawStandaloneBuildInfo", {
    mode: "aot",
    openclaw: { version: "2026.10.3", commit: "a".repeat(40) },
    bun: { version: "1.4.4" },
    target: { platform: "darwin", arch: "arm64" },
    build: {
      id: "synthetic",
      flavor: "standard",
      pluginSetSha256: "b".repeat(64),
      moduleGraphSha256: "c".repeat(64),
    },
    plugins: { embedded: ["codex"], omitted: [] },
    nativeModules: [
      {
        name: "@openclaw/fs-safe",
        version: "0.26.11",
        artifacts: ["native/fs-safe.node"],
        qualification: "unverified",
        backend: "runtime-selected",
      },
    ],
  });
  vi.stubEnv("NODE_OPTIONS", "--disallow-code-generation-from-strings");
  vi.stubEnv("BUN_OPTIONS", "--disallow-code-generation-from-strings");
  const report = collectRuntimeCapabilities();
  expect(report.process.flavor).toBe("aot");
  expect(report.capabilities).toMatchObject({
    codeGenerationFromStrings: { state: "unavailable" },
    executableMemory: { state: "unknown", scope: "this-process" },
    interpreter: { state: "unknown" },
    debugger: { state: "unavailable" },
  });
  expect(report.nativeCompatibility.modules).toEqual([
    expect.objectContaining({ name: "@openclaw/fs-safe", qualification: "unverified" }),
  ]);
  expect(report.execution).toEqual({ profile: "embedded-aot", dynamicCode: "interpreted" });
  expect(formatRuntimeCapabilities(report)).toContain("flavor=aot");
  expect(formatRuntimeCapabilities(report)).toContain("run interpreted in this AOT build");
  vi.stubGlobal("__openclawStandaloneBuildInfo", {
    mode: "jit",
    openclaw: { version: "2026.10.3" },
    bun: { version: "1.4.4" },
  });
  expect(collectRuntimeCapabilities().execution).toEqual(report.execution);
});

it("honors the last code-generation flag and leaves malformed environment options unknown", () => {
  vi.stubEnv(
    "NODE_OPTIONS",
    "--disallow-code-generation-from-strings --disallow-code-generation-from-strings=false",
  );
  vi.stubEnv(
    "BUN_OPTIONS",
    "--disallow-code-generation-from-strings --disallow-code-generation-from-strings=false",
  );
  expect(collectRuntimeCapabilities().capabilities.codeGenerationFromStrings.state).toBe(
    "available",
  );
  vi.stubEnv("NODE_OPTIONS", '"unterminated');
  vi.stubEnv("BUN_OPTIONS", '"unterminated');
  expect(collectRuntimeCapabilities().capabilities.codeGenerationFromStrings.state).toBe("unknown");
});

it("keeps CPU, heap sampling and snapshots independent and distinguishes transient admission failures", async () => {
  const success = { status: "complete", result: {} } as const;
  expect(await observeRuntimeProfileCapability("cpuProfiling", Promise.resolve(success))).toBe(
    success,
  );
  await observeRuntimeProfileCapability(
    "cpuProfiling",
    Promise.resolve({ status: "unavailable", reason: "busy", cleanupFailed: false }),
  );
  await observeRuntimeProfileCapability(
    "heapSampling",
    Promise.resolve({ status: "unavailable", reason: "unsupported", cleanupFailed: false }),
  );
  expect(collectRuntimeCapabilities().capabilities).toMatchObject({
    cpuProfiling: { state: "available", reason: expect.stringContaining("busy") },
    heapSampling: { state: "unavailable" },
    heapSnapshot: { state: "unknown" },
  });
});
