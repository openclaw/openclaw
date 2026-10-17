import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManagedHandoffTempDirTracker } from "./update-managed-service-handoff-artifacts.test-support.js";
import type {
  ManagedServiceManagerBoundaryOptions,
  ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import type { UpdateRunResult } from "./update-runner-types.js";

type RunBoundary = (
  kind: "systemd" | "launchd",
  options?: ManagedServiceManagerBoundaryOptions,
) => Promise<ManagedServiceManagerBoundaryResult>;
const gitRecovery = (buildId = "original-git-build") => ({
  serviceRestartSafe: true,
  version: "1.0.0",
  buildId,
});
const restoreStep = (exitCode: number) => ({
  name: "service-restore",
  log: {
    exitCode,
    ...(exitCode ? { stderrTail: "managed-service-handoff-restore-failed" } : {}),
  },
});
const gitOutcome = (status: string, reason: string, buildId?: string) => ({
  status,
  reason,
  mode: "git",
  recovery: gitRecovery(buildId),
});
const rollbackResult = {
  status: "error",
  mode: "npm",
  before: { version: "1.0.0" },
  after: { version: "1.0.0" },
  recovery: { serviceRestartSafe: true, packageRollbackVerified: true, version: "1.0.0" },
};
const startsService = (commands: string[], reset = true) =>
  commands.some((command) =>
    (reset
      ? /(?:^| )(?:start|reset-failed|enable|bootstrap|kickstart)(?: |$)/
      : /(?:^| )(?:start|enable|bootstrap|kickstart)(?: |$)/
    ).test(command),
  );
const sentinelResult = (status: string, stats?: unknown) => ({
  payload: { status, ...(stats ? { stats } : {}) },
});

export function registerManagedTerminalResultTests(
  runBoundary: RunBoundary,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
  tempDirs: ManagedHandoffTempDirTracker,
): void {
  itUnix.each(["ready", "unready"] as const)(
    "finishes a cancelled handoff ledger when recovery is %s without a Gateway boot",
    async (gatewayHealth) => {
      const { run } = await runBoundary("systemd", {
        ledger: true,
        cancelAfterPark: true,
        gatewayHealth,
      });
      expect(run).toMatchObject({
        phase: "finished",
        status: gatewayHealth === "ready" ? "skipped" : "failed",
        reason:
          gatewayHealth === "ready"
            ? "managed-service-handoff-cancelled"
            : "managed-service-handoff-restore-failed",
        verification: { serviceRunning: true, runningVersion: "1.0.0", versionMatch: true },
      });
      expect(run?.verification.booted).toBeUndefined();
      expect(run?.downtimeMs).toEqual(gatewayHealth === "ready" ? expect.any(Number) : null);
      expect(run?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: "service-stop",
            status: "completed",
            startedAtMs: expect.any(Number),
          }),
        ]),
      );
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["git", "npm"] as const).flatMap((mode) =>
        (["same", "replacement", "replacement-symlink"] as const).flatMap((rootKind) =>
          (["published", "consumed"] as const).map(
            (notification) => [kind, mode, rootKind, notification] as const,
          ),
        ),
      ),
    ),
  )(
    "%s preserves completed %s success at %s root (notification=%s)",
    async (kind, mode, rootKind, updaterNotification) => {
      let root: string | undefined;
      if (rootKind !== "same") {
        const replacement = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-replacement-")),
        );
        tempDirs.add(replacement);
        root = path.join(replacement, "checkout");
        await fs.mkdir(root);
        if (rootKind === "replacement-symlink") {
          const link = path.join(replacement, "global-package");
          await fs.symlink(root, link, "dir");
          expect(await fs.realpath(link)).toBe(root);
          root = link;
        }
      }
      const updaterResult = {
        status: "ok",
        mode,
        ...(root ? { root } : {}),
        before: { version: "1.0.0", ...(mode === "git" ? { sha: "a".repeat(40) } : {}) },
        after: {
          version: "1.1.0",
          ...(mode === "git" ? { sha: "b".repeat(40), buildId: "updated-git-build" } : {}),
        },
        steps: [],
        durationMs: 100,
      } satisfies UpdateRunResult;
      const { commands, state, sentinel } = await runBoundary(kind, {
        updaterExitCode: 0,
        updaterResult,
        updaterNotification,
        recordedFailure: { error: "A diagnostic export cannot override direct success." },
      });
      expect(startsService(commands)).toBe(false);
      expect(state.restored).toBeUndefined();
      expect(state.healthProbed).toBeUndefined();
      expect(state.triageCalls).toBeUndefined();
      expect(state.publishedSentinel).toMatchObject({ payload: { status: "ok", stats: { mode } } });
      if (updaterNotification === "consumed") {
        expect(state.consumedNotifications).toBe(1);
        expect(sentinel).toBeNull();
      } else {
        expect(state.consumedNotifications).toBeUndefined();
        expect(sentinel).toEqual(state.publishedSentinel);
      }
    },
  );

  itUnix.each(
    (["systemd", "launchd"] as const).flatMap((kind) =>
      (["error", "skipped"] as const).map((status) => [kind, status] as const),
    ),
  )("%s rejects foreign-root %s recovery despite positive runtime proof", async (kind, status) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-foreign-")),
    );
    tempDirs.add(root);
    const { commands, state, sentinel } = await runBoundary(kind, {
      updaterExitCode: status === "skipped" ? 0 : 7,
      helperExitCode: status === "skipped" ? 1 : 7,
      updaterResult: {
        status,
        root,
        mode: "git",
        steps: [],
        durationMs: 100,
        recovery: gitRecovery(),
      } satisfies UpdateRunResult,
      recordedFailure: {
        result: {
          status: "error",
          mode: "git",
          steps: [],
          recovery: { serviceRestartSafe: true },
        },
      },
    });
    expect(startsService(commands)).toBe(false);
    expect(state.restored).toBeUndefined();
    expect(state.healthProbed).toBeUndefined();
    expect(state.triageCalls).toBe(1);
    expect(sentinel).toMatchObject(
      sentinelResult("error", { reason: "managed-service-handoff-failed" }),
    );
  });
}

export function registerManagedRecoveryOutcomeTests(
  runBoundary: RunBoundary,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
  kinds: readonly ("systemd" | "launchd")[],
): void {
  itUnix.each(
    kinds.flatMap((kind) =>
      (["ready", "exited", "throw"] as const).map((health) => [kind, health] as const),
    ),
  )(
    "restores the verified previous %s generation after updater exit 79 (health=%s)",
    async (kind, gatewayHealth) => {
      const { run, state, log } = await runBoundary(kind, {
        ledger: true,
        rollbackRestoration: true,
        updaterExitCode: 79,
        helperExitCode: gatewayHealth === "ready" ? 1 : 79,
        gatewayHealth,
        updaterResult: { ...rollbackResult, reason: "restart-unhealthy" },
      });
      expect(state).toMatchObject({
        restored: true,
        healthProbeCount: 1,
        expectedVersion: "1.0.0",
        recoveryAllowance: "1",
        triageObservedRestored: true,
      });
      expect(state.triageRecoveryAllowance).toBeUndefined();
      expect(run, log).toMatchObject({
        status: gatewayHealth === "ready" ? "rolled-back" : "failed",
        reason: "restart-unhealthy",
        after: { version: "1.0.0" },
        verification: {
          serviceRunning: gatewayHealth !== "exited",
        },
        downtimeMs: gatewayHealth === "ready" ? expect.any(Number) : null,
      });
      const { runningVersion, versionMatch, pid, readyz, settled, channelsReady, pluginErrors } =
        run?.verification ?? {};
      const unreadable = gatewayHealth === "throw";
      const ready = unreadable ? undefined : gatewayHealth === "ready";
      expect([runningVersion, versionMatch, pid, readyz]).toEqual([
        unreadable ? undefined : "1.0.0",
        unreadable ? undefined : true,
        gatewayHealth === "exited" ? undefined : process.pid,
        undefined,
      ]);
      expect([settled, channelsReady]).toEqual([ready, ready]);
      expect(pluginErrors).toEqual(unreadable ? undefined : []);
      expect(log).not.toContain("keep the gateway stopped");
    },
  );

  itUnix.each(
    kinds.flatMap((kind) =>
      (["none", "stdout-only", "ledger-only"] as const).map((proof) => [kind, proof] as const),
    ),
  )(
    "keeps %s parked on unsafe exit 79 without a complete recovery verdict (proof=%s)",
    async (kind, proof) => {
      const { commands, sentinel, state } = await runBoundary(kind, {
        updaterExitCode: 79,
        ledger: proof === "ledger-only",
        rollbackRestoration: proof === "ledger-only",
        recordedFailure:
          proof === "stdout-only"
            ? {
                error: "Diagnostic restart safety must not override the direct updater outcome",
                result: {
                  status: "error",
                  mode: "npm",
                  recovery: { serviceRestartSafe: true },
                  steps: [],
                },
              }
            : undefined,
        updaterResult: proof === "stdout-only" ? rollbackResult : undefined,
      });

      expect([state.parked, state.restored]).toEqual([true, undefined]);
      expect(state).toMatchObject({
        triageCalls: 1,
        triageObservedRestored: false,
        triageObservedRecovery: false,
      });
      expect(
        commands.some((command) => /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command)),
      ).toBe(false);
      expect(sentinel).toMatchObject(
        sentinelResult("error", { reason: "managed-service-handoff-unsafe-recovery", steps: [] }),
      );
    },
  );

  itUnix.each(kinds)(
    "%s never overrides a rejected or missing updater recovery result",
    async (kind) => {
      for (const updaterResult of [
        undefined,
        { status: "error", mode: "git", recovery: { serviceRestartSafe: true, version: "1.0.0" } },
        ...(["healthy", "failed"] as const).map((service) => ({
          status: "error",
          mode: "npm",
          recovery: { serviceRestartSafe: true, version: "1.0.0", service },
        })),
        {
          status: "error",
          mode: "npm",
          reason: "doctor-failed",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
      ]) {
        const { commands, state, sentinel } = await runBoundary(kind, {
          updaterResult,
          updaterNotification: "published",
        });
        expect(startsService(commands)).toBe(false);
        expect(state.restored).toBeUndefined();
        expect(sentinel).toMatchObject(sentinelResult("error"));
      }
    },
  );

  itUnix.each([
    ...kinds.flatMap((kind) =>
      (["error", "skipped"] as const).flatMap((status) =>
        ([undefined, "published", "consumed"] as const).map(
          (notification) => [kind, status, notification, undefined] as const,
        ),
      ),
    ),
    ...kinds.map((kind) => [kind, "error", "published", "split-utf8"] as const),
  ])(
    "%s restores verified Git %s before the child owns a stop (notification=%s, output=%s)",
    async (kind, status, updaterNotification, updaterOutput) => {
      const reason = status === "skipped" ? "no-upstream" : "preflight-fetch";
      const { commands, state, sentinel, log } = await runBoundary(kind, {
        updaterExitCode: status === "skipped" ? 0 : 7,
        helperExitCode: status === "skipped" ? 1 : 7,
        updaterNotification,
        updaterOutput,
        updaterResult: gitOutcome(status, reason),
      });
      expect(
        commands.filter((command) => /(?:^| )(?:start|bootstrap|kickstart)(?: |$)/.test(command)),
      ).toHaveLength(1);
      expect(state).toMatchObject({
        restored: true,
        healthProbeCount: 1,
        expectedVersion: "1.0.0",
        expectedBuildId: "original-git-build",
        triageCalls: 1,
        triageObservedRestored: true,
        triageObservedRecovery: true,
      });
      expect(log).toContain(JSON.stringify(reason));
      if (updaterNotification === "published") {
        expect(sentinel).toMatchObject(sentinelResult(status, { reason, steps: [restoreStep(0)] }));
      } else {
        expect(sentinel).toBeNull();
      }
    },
  );

  itUnix.each(
    kinds.flatMap((kind) =>
      (["error", "skipped"] as const).flatMap((status) =>
        [
          undefined,
          { serviceRestartSafe: false, reason: "state-migration-started" },
          { serviceRestartSafe: true, version: "1.0.0" },
          ...(["healthy", "failed"] as const).map((service) => ({
            serviceRestartSafe: true,
            version: "1.0.0",
            buildId: "original-git-build",
            service,
          })),
        ].map((recovery) => [kind, status, recovery] as const),
      ),
    ),
  )(
    "%s preserves terminal foreground %s and rejects unverified recovery (%j)",
    async (kind, status, recovery) => {
      const reason = status === "skipped" ? "no-upstream" : "preflight-fetch";
      const { commands, state, sentinel, log, run } = await runBoundary(kind, {
        ledger: true,
        updaterExitCode: status === "skipped" ? 0 : 7,
        helperExitCode: status === "skipped" ? 1 : 7,
        updaterNotification: "consumed",
        updaterResult: { status, reason, mode: "git", recovery },
      });
      expect(startsService(commands, false)).toBe(false);
      expect(state.healthProbed).toBeUndefined();
      expect(log).toContain("managed update recovery not attempted:");
      const availabilityUnverified =
        !recovery || !("service" in recovery) || recovery.service === "failed";
      if (availabilityUnverified) {
        expect(log).toContain("Gateway recovery failed after the update");
        expect(run?.steps).toContainEqual(
          expect.objectContaining({
            step: "warning:gateway-availability",
            detail: expect.stringContaining("Gateway recovery failed after the update"),
          }),
        );
      } else {
        expect(log).not.toContain("Gateway recovery failed after the update");
      }
      if (recovery && "service" in recovery) {
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel).toMatchObject(sentinelResult("error", { reason }));
      }
    },
  );

  itUnix.each(kinds)(
    "%s parks an updater with missing, malformed, oversized, interrupted, or rootless output",
    async (kind) => {
      for (const fault of [
        "missing",
        "malformed",
        "overflow",
        "signal",
        "missing-root",
        "invalid-root",
      ] as const) {
        const { state, sentinel } = await runBoundary(kind, {
          updaterExitCode: 0,
          helperExitCode: 1,
          updaterOutput:
            fault === "signal" || fault === "missing-root" || fault === "invalid-root"
              ? undefined
              : fault,
          updaterSignal: fault === "signal",
          updaterResult: {
            status: "ok",
            mode: "npm",
            ...(fault === "missing-root"
              ? { root: undefined }
              : fault === "invalid-root"
                ? { root: 42 }
                : {}),
            steps: [],
            durationMs: 100,
            recovery: { serviceRestartSafe: true, version: "1.0.0" },
          },
        });
        expect(state.restored).toBeUndefined();
        expect(state.healthProbed).toBeUndefined();
        expect(state.triageCalls).toBe(1);
        expect(sentinel).toMatchObject(
          sentinelResult("error", { reason: "managed-service-handoff-failed" }),
        );
      }
    },
  );

  itUnix.each(
    kinds.flatMap((kind) =>
      (["error", "skipped"] as const).map((status) => [kind, status] as const),
    ),
  )("%s verifies restored Gateway readiness and identity after %s", async (kind, status) => {
    const skipped = status === "skipped";
    const reason = skipped ? "no-upstream" : "preflight-fetch";
    const failures = ["unready", "wrong-version", "wrong-build", "exited"] as const;
    for (const gatewayHealth of skipped ? failures : ([...failures, "ready"] as const)) {
      const { sentinel, state } = await runBoundary(kind, {
        updaterNotification: "published",
        updaterResult: gitOutcome(status, reason, skipped ? undefined : "restored-git-build"),
        ...(skipped ? { updaterExitCode: 0, helperExitCode: 1 } : {}),
        gatewayHealth,
      });
      expect(state).toMatchObject(
        skipped
          ? { restored: true, healthProbeCount: 1 }
          : {
              healthProbed: true,
              expectedVersion: "1.0.0",
              expectedBuildId: "restored-git-build",
            },
      );
      const stats = {
        reason,
        steps: skipped
          ? [restoreStep(1)]
          : expect.arrayContaining([
              expect.objectContaining(restoreStep(gatewayHealth === "ready" ? 0 : 1)),
            ]),
      };
      expect(sentinel).toMatchObject({
        payload: { ...(skipped ? { status: "error" } : {}), stats },
      });
    }
  });
}
