import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDaemonStop } from "../cli/daemon-cli/lifecycle.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { GatewayService } from "../daemon/service.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import type { GatewayHostLifecycle } from "../gateway/server-public.js";
import { defaultRuntime } from "../runtime.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const { service, appendAudit } = vi.hoisted(() => ({
  service: {
    label: "Test service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn<GatewayService["stage"]>(),
    install: vi.fn<GatewayService["install"]>(),
    uninstall: vi.fn<GatewayService["uninstall"]>(),
    start: vi.fn<GatewayService["start"]>(),
    stop: vi.fn<GatewayService["stop"]>(),
    restart: vi.fn<GatewayService["restart"]>(),
    isLoaded: vi.fn<GatewayService["isLoaded"]>(),
    readCommand: vi.fn<GatewayService["readCommand"]>(),
    readRuntime: vi.fn<GatewayService["readRuntime"]>(),
  } satisfies GatewayService,
  appendAudit: vi.fn<typeof import("./audit.js").appendSystemAgentAuditEntry>(),
}));

// Keep load-state normalization and CLI failure handling real; only the OS adapter is replaced.
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));

vi.mock("../config/config.js", async () => {
  const { resolveGatewayPort } = await import("../config/paths.js");
  const snapshot: ConfigFileSnapshot = {
    path: "/test/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    sourceConfig: {},
    resolved: {},
    runtimeConfig: {},
    config: {},
    valid: true,
    hash: "lifecycle-test-config",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
  return {
    getRuntimeConfig: () => ({}),
    readBestEffortConfig: async () => ({}),
    readConfigFileSnapshot: async () => snapshot,
    resolveGatewayPort,
  };
});

vi.mock("./audit.js", () => ({
  SYSTEM_AGENT_AUDIT_STORE_LABEL: "test audit",
  appendSystemAgentAuditEntry: appendAudit,
}));

describe("SystemAgent hosted gateway lifecycle", () => {
  const exitSentinel = new Error("native CLI attempted to exit the host");

  beforeEach(() => {
    vi.clearAllMocks();
    service.isLoaded.mockReset().mockResolvedValue(true);
    service.stop.mockReset().mockResolvedValue(undefined);
    // Preserve the real service-identity guard within the wrapper's isolated HOME.
    mockSystemAccountHome();
    for (const key of [
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_PROFILE",
      "OPENCLAW_SUPERVISOR_MODE",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw exitSentinel;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { kind: "gateway-start", outcome: "already-running", summary: "Gateway already running" },
    { kind: "gateway-stop", outcome: "scheduled", summary: "Scheduled Gateway stop" },
    { kind: "gateway-restart", outcome: "scheduled", summary: "Scheduled Gateway restart" },
  ] as const)(
    "audits the hosted $kind outcome without claiming native completion",
    async ({ kind, outcome, summary }) => {
      const request = vi.fn<GatewayHostLifecycle["request"]>(async (_action, assertCaller) => {
        assertCaller();
        return { ok: true, value: { outcome } };
      });
      const { runtime, lines } = createSystemAgentTestRuntime();
      const guard = vi.fn();
      const deps = { setupSurface: "gateway" as const, gatewayHostLifecycle: { request } };
      await expect(executeSystemAgentOperation({ kind }, runtime, { deps })).resolves.toMatchObject(
        { applied: false },
      );
      expect(request).not.toHaveBeenCalled();
      await expect(
        executeSystemAgentOperation({ kind }, runtime, {
          approved: true,
          beforePersistentApply: guard,
          deps,
        }),
      ).resolves.toMatchObject({ applied: true });
      expect(guard).toHaveBeenCalledOnce();
      expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ summary }));
      expect(lines).toContain(summary);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.stop).not.toHaveBeenCalled();
    },
  );

  it("does not audit a rejected hosted stop as an applied operation", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(
      executeSystemAgentOperation({ kind: "gateway-stop" }, runtime, {
        approved: true,
        deps: {
          setupSurface: "gateway",
          gatewayHostLifecycle: {
            request: async () => ({ ok: false, error: "native service ownership changed" }),
          },
        },
      }),
    ).rejects.toThrow("native service ownership changed");
    expect(appendAudit).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done:");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("rejects gateway-stop without a host lifecycle before reaching the exiting native CLI", async () => {
    service.isLoaded.mockRejectedValue(new Error("service inspection failure"));
    await expect(runDaemonStop({ force: true })).rejects.toBe(exitSentinel);
    expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("service inspection failure"),
    );
    vi.clearAllMocks();

    const { runtime, lines } = createSystemAgentTestRuntime();
    const captureExit = vi.spyOn(runtime, "exit");
    await expect(
      executeSystemAgentOperation({ kind: "gateway-stop" }, runtime, {
        approved: true,
        deps: { setupSurface: "gateway" },
      }),
    ).rejects.toThrow("Gateway host lifecycle is unavailable");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(captureExit).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done:");
  });
});
