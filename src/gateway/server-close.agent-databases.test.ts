import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import {
  createReplyOperation,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { runGatewayLoop } from "../cli/gateway-cli/run-loop.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import * as systemdTimeout from "../infra/systemd-stop-timeout.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  OpenClawAgentDatabaseLeaseActiveError,
} from "../state/openclaw-agent-db-lease.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import * as schema from "../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { readOpenClawAgentIntegrityVerification } from "../state/openclaw-quarantine-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import type { GatewayServer } from "./server-public.js";

it.each(["stop", "restart"] as const)(
  "releases agent leases for Doctor after the final Gateway %s while its process stays alive",
  async (mode) => {
    const fixture = await createGatewayMetadataCloseFixture(`gateway-agent-leases-${mode}`);
    const ownerPid = process.pid;
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: fixture.pluginId });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    setActivePluginRegistry(registry);
    const sessionScope = {
      agentId: "main",
      storePath: path.join(fixture.state.sessionsDir("main"), "sessions.json"),
      sessionKey: "agent:main:close-preservation",
    };
    const pluginState: NonNullable<SessionEntry["pluginExtensions"]> = {
      [instance.pluginId]: { active: true },
      other: { value: "preserve" },
    };
    try {
      const first = await fixture.start(await fixture.reservePort());
      await replaceSessionEntry(sessionScope, {
        sessionId: "close-preservation",
        updatedAt: 1,
        pluginExtensions: pluginState,
      });
      // A sibling without this plugin must not turn Gateway close into plugin removal.
      setActivePluginRegistry(createEmptyPluginRegistry());
      const siblingPort = await fixture.reservePort();
      const sibling = await fixture.start(siblingPort);
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options);
      const incognito = openOpenClawAgentDatabase({
        ...options,
        path: resolveIncognitoOpenClawAgentSqlitePath(options),
      });
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const inspectForDoctor = () =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env });
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const closeOptions = {
        reason: mode === "restart" ? "gateway restarting" : "gateway stopping",
        restartExpectedMs: mode === "restart" ? 1_500 : null,
      };

      await first.close(closeOptions);
      expect(loadSessionEntry(sessionScope)?.pluginExtensions).toEqual(pluginState);
      expect(agent.db.isOpen).toBe(true);
      expect(incognito.db.isOpen).toBe(true);
      expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
      const response = await fetch(`http://127.0.0.1:${siblingPort}/healthz`);
      await response.body?.cancel();
      expect(response.ok).toBe(true);

      await sibling.close(closeOptions);
      expect(process.pid).toBe(ownerPid);
      expect(isPidAlive(ownerPid)).toBe(true);
      expect(inspectForDoctor).not.toThrow();
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(incognito.db.isOpen).toBe(false);
      expect(listOpenIncognitoAgentDatabases()).not.toContainEqual({
        agentId: "main",
        storePath: incognito.path,
      });
      expect(loadSessionEntry(sessionScope)?.pluginExtensions).toEqual(pluginState);
    } finally {
      await fixture.cleanup();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "joins agent resources and records a clean witness after a managed SIGTERM drain",
  async () => {
    const fixture = await createGatewayMetadataCloseFixture("gateway-agent-resource-close");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const started = createDeferredCore<GatewayServer>();
    const exited = createDeferredCore<number>();
    const exit = vi.fn((code: number) => exited.resolve(code));
    const completeBoot = vi.fn();
    const previousStops = new Set(process.listeners("SIGTERM"));
    let closing: Promise<void> | undefined;
    let unregister: (() => void) | undefined;
    let stop: ((signal: "SIGTERM") => void) | undefined;
    let operation: ReplyOperation | undefined;
    try {
      for (const name of SUPERVISOR_HINT_ENV_VARS) {
        vi.stubEnv(name, undefined);
      }
      vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", fixture.state.env.OPENCLAW_LAUNCHD_LABEL);
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      vi.spyOn(systemdTimeout, "readSystemdStopTimeout").mockResolvedValue({
        timeoutMs: 90_000,
        source: "systemd fixture TimeoutStopUSec",
      });
      const port = await fixture.reservePort();
      void runGatewayLoop({
        lockPort: port,
        completeBoot,
        start: async (options) => {
          const server = await fixture.start(port, {
            hostLifecycle: options?.hostLifecycle,
            startupOperation: options?.startupOperation,
          });
          started.resolve(server);
          return server;
        },
        runtime: { log() {}, error() {}, exit },
      }).catch(started.reject);
      const server = await started.promise;
      await nextTurn();
      stop = process.listeners("SIGTERM").find((listener) => !previousStops.has(listener));
      assert(stop);
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      operation = createReplyOperation({
        sessionKey: "agent:main:managed-restart",
        sessionId: "managed-restart",
        resetTriggered: false,
      });
      operation.setPhase("running");
      bindGatewayContextResolver(operation, kernel.resolvePluginGatewayContext);
      operation.abortSignal.addEventListener("abort", () => operation?.complete(), { once: true });
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options);
      agent.db.exec("INSERT INTO auth_profile_state VALUES ('restart-proof', '{}', 1)");
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: "main",
        path: agent.path,
        revoke() {},
        async close() {
          entered.resolve();
          await release.promise;
        },
      });
      expect(
        writeGatewayRestartIntentSync({
          env: fixture.state.env,
          targetPid: process.pid,
          intent: { reason: "gateway.restart", force: true, waitMs: 30_000 },
        }),
      ).toBe(true);
      const close = vi.spyOn(server, "close");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      stop("SIGTERM");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(operation.abortSignal.aborted).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1_500,
        drainTimeoutMs: 0,
      });
      closing = close.mock.results[0]?.value;
      assert(closing);
      await Promise.race([
        entered.promise,
        closing.then(() => {
          throw new Error("Gateway acknowledged closure before its agent resource joined");
        }),
      ]);
      expect(isAgentRunRestartAbortReason(operation.abortSignal.reason)).toBe(true);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(exit).not.toHaveBeenCalled();
      expect(agent.db.isOpen).toBe(true);
      expect(shared.isOpen).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
        OpenClawAgentDatabaseLeaseActiveError,
      );
      await vi.advanceTimersByTimeAsync(4_999);
      release.resolve();
      await closing;
      await expect(exited.promise).resolves.toBe(0);
      expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
        outcome: "planned_restart",
        reason: expect.stringMatching(/restart \(SIGTERM: gateway\.restart\)$/),
      });
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
      ).not.toThrow();
      expect(
        readOpenClawAgentIntegrityVerification(agent.path, fixture.state.env)?.clean_close,
      ).toBe(1);
      closeOpenClawAgentDatabasesForTest(fixture.state.stateDir);
      resetGatewayWorkAdmission();
      const gate = schema.agentDatabaseIntegrityBeforeMutationSteps;
      let diagnostics: SqliteIntegrityDiagnostics | undefined;
      vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
        ...args
      ) {
        const result = yield* gate(...args);
        diagnostics = args[3];
        return result;
      });
      const reopened = openOpenClawAgentDatabase(options);
      expect(diagnostics?.integrityGateOutcome).toBe("cached");
      expect(
        reopened.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='restart-proof'")
          .get(),
      ).toEqual({ state_json: "{}" });
    } finally {
      release.resolve();
      operation?.complete();
      await Promise.allSettled([closing]);
      vi.useRealTimers();
      if (!exit.mock.calls.length && stop) {
        stop("SIGTERM");
        await exited.promise;
      }
      unregister?.();
      await fixture.cleanup();
      resetGatewayWorkAdmission();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  },
);

it("rejects Gateway closure when an agent handle cannot close and retains its lease", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-close-failure");
  let restoreClose: (() => void) | undefined;
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const failure = new Error("native agent database close failed");
    const blockedClose = vi.spyOn(agent.db, "close").mockImplementation(() => {
      throw failure;
    });
    restoreClose = () => blockedClose.mockRestore();

    const outcome = await server
      .close({ reason: "gateway restarting", restartExpectedMs: 1_500 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(collectNestedErrorCandidates(outcome)).toContain(failure);
    expect(agent.db.isOpen).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
      OpenClawAgentDatabaseLeaseActiveError,
    );
  } finally {
    restoreClose?.();
    await fixture.cleanup();
  }
});
