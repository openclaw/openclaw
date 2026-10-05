import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { resolveCliCommandPathPolicy } from "../cli/command-path-policy.js";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import {
  replaceSessionEntrySync,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { writePlacementEnvironmentFixture } from "../gateway/worker-environments/placement-test-fixtures.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { inspectDoctorSessionRecovery } from "./doctor-session-recovery.js";

function sourceBytes(paths: string[]) {
  return paths
    .flatMap((pathname) => [pathname, `${pathname}-wal`, `${pathname}-shm`])
    .map((pathname) => [
      pathname,
      fs.existsSync(pathname)
        ? createHash("sha256").update(fs.readFileSync(pathname)).digest("hex")
        : null,
    ]);
}

it("inspects the exact protected session through Doctor without replay, writes, or issuer minting", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const shared = openOpenClawStateDatabase({ env: state.env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:recovery-inspect",
      sessionId: "original-session",
      storePath: agent.path,
    };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original-lifecycle",
      status: "interrupted" as const,
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: "creator-is-not-an-issuer",
      },
      goal: {
        schemaVersion: 1 as const,
        id: "original-goal",
        status: "paused" as const,
        objective: "private-goal-sentinel",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
      goalPauseOrigin: "terminal-error" as const,
    };
    replaceSessionEntrySync(scope, entry);
    const pending = await stageSessionPendingInput(scope, {
      runId: "pending-run",
      message: {
        role: "user",
        content: "private-input-sentinel",
        idempotencyKey: "pending-run:user",
        timestamp: 10,
      },
      assertCurrent: () => {},
    });
    expect(pending).toBeDefined();
    pending!.finish("interrupted");
    await pending!.settled?.();
    await replaceTranscriptEvents(scope, [{ type: "session", id: scope.sessionId }]);
    await waitForSessionTranscriptProjection(scope);
    const placements = createWorkerSessionPlacementStore({ database: shared });
    const requested = await placements.startDispatch(scope);
    const provisioning = await placements.transition({
      sessionId: scope.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "original-environment" },
    });
    const failed = await placements.fail({
      sessionId: scope.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "private-error-sentinel",
    });
    writePlacementEnvironmentFixture(shared, {
      environmentId: "original-environment",
      state: "failed",
      ownerEpoch: 0,
      attachedSessionIds: [],
      leaseId: null,
      providerId: "crabbox",
      profileId: "vm-profile",
    });
    const protectedDir = state.path("protected-capture");
    fs.mkdirSync(protectedDir);
    const agentDb = path.join(protectedDir, "agent.sqlite");
    const stateDb = path.join(protectedDir, "openclaw.sqlite");
    const capture = () => {
      for (const [source, destination] of [
        [agent.path, agentDb],
        [shared.path, stateDb],
      ]) {
        for (const suffix of ["", "-wal", "-shm"]) {
          if (fs.existsSync(`${source}${suffix}`)) {
            fs.copyFileSync(`${source}${suffix}`, `${destination}${suffix}`);
          } else {
            fs.rmSync(`${destination}${suffix}`, { force: true });
          }
        }
      }
    };
    capture();
    const options = {
      ...scope,
      agentDb,
      stateDb,
      lifecycleRevision: entry.lifecycleRevision,
      placementGeneration: failed.generation,
    };
    const original = sourceBytes([agentDb, stateDb]);
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    try {
      const program = new Command().name("openclaw");
      registerMaintenanceCommands(program);
      await expect(
        program.parseAsync(
          [
            "doctor",
            "recovery-inspect",
            "--agent-db",
            agentDb,
            "--state-db",
            stateDb,
            "--agent",
            scope.agentId,
            "--key",
            scope.sessionKey,
            "--session-id",
            scope.sessionId,
            "--lifecycle",
            entry.lifecycleRevision,
            "--placement-generation",
            String(failed.generation),
          ],
          { from: "user" },
        ),
      ).rejects.toMatchObject<Partial<ExitError>>({ code: 0 });
      expect(writeJson).toHaveBeenCalledOnce();
      const diagnostic = writeJson.mock.calls[0]![0];
      expect(diagnostic).toMatchObject({
        diagnosticOnly: true,
        agent: {
          status: "read",
          goalPauseOrigin: "terminal-error",
          restart: { turnIssuer: null, goalIssuer: null },
          effects: { status: "read", unresolvedEffect: false, unresolvedAcrossTurns: false },
          committed: { status: "read", effectHold: null, candidate: null },
          pending: {
            status: "read",
            inputs: [{ runId: "pending-run", capture: "absent", issuer: null }],
          },
        },
        source: {
          status: "read",
          neverActivated: true,
          environmentGone: true,
          environment: { leasePresent: false, providerReleaseRecorded: null },
        },
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(
        /private-|creator-is-not|fingerprint|requestHash|messageHash/,
      );
      expect(sourceBytes([agentDb, stateDb])).toEqual(original);
    } finally {
      writeJson.mockRestore();
    }
    for (const mismatch of [
      { sessionId: "successor-session" },
      { lifecycleRevision: "successor-lifecycle" },
    ]) {
      const result = await inspectDoctorSessionRecovery({ ...options, ...mismatch });
      expect(result.agent).toEqual({ status: "identity-mismatch" });
    }
    expect(
      (
        await inspectDoctorSessionRecovery({
          ...options,
          placementGeneration: failed.generation + 1,
        })
      ).source,
    ).toEqual({ status: "identity-mismatch" });

    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId },
      {
        type: "message",
        id: "unresolved-effect",
        parentId: null,
        timestamp: 20,
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "effect-call",
              name: "exec",
              arguments: { command: "private-command-sentinel" },
            },
          ],
        },
      },
    ]);
    await waitForSessionTranscriptProjection(scope);
    capture();
    const held = await inspectDoctorSessionRecovery(options);
    expect(held.agent).toMatchObject({
      effects: { status: "read", unresolvedEffect: true, unresolvedAcrossTurns: true },
    });
    agent.db
      .prepare("UPDATE session_transcript_index_state SET indexed_seq = -1 WHERE session_id = ?")
      .run(scope.sessionId);
    capture();
    const unknown = await inspectDoctorSessionRecovery(options);
    expect(unknown.agent).toMatchObject({
      effects: { status: "unavailable" },
      committed: { status: "unavailable" },
    });
    expect(resolveCliCommandPathPolicy(["doctor", "recovery-inspect"])).toMatchObject({
      configGuard: "skip",
      loadPlugins: "never",
      ensureCliPath: false,
      networkProxy: "bypass",
      ownsProtocolStdout: true,
      hideBanner: true,
    });
  });
});
