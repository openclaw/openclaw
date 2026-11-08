import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { readPersistedFileStat } from "../agents/sessions/tools/file-write-verification.js";
import { createWriteTool } from "../agents/sessions/tools/write.js";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { buildSessionEventContext } from "../auto-reply/reply/session-event-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { saveCronStore } from "../cron/store.js";
import type { CronStoredJob } from "../cron/types.js";
import { isMissingPathError } from "../infra/errors.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureCronJobTurnTarget } from "./cron-job-turn-target.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-authority.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it.each(["device revocation", "email reassignment", "email restoration"] as const)(
  "restores native cron owner continuation, persists its child write, and fences the final write after %s",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const profile = ensureProfileForEmail("recovery@example.test");
      const fixture = await recoveryFixture(stateDir, profile.id, {
        device: pairedOperator(),
        clientInfo: { id: "openclaw-macos", mode: "ui" },
      });
      const serializedSource = JSON.stringify({
        version: 1,
        agentId: fixture.target.agentId,
        sessionKey: fixture.target.sessionKey,
        sessionId: fixture.target.sessionId,
        sourceRunId: "native-scheduled-source",
        snapshot: fixture.snapshot,
      });
      // Keep this profile independent when its original authentication email moves.
      linkEmail("retained@example.test", profile.id);
      setRuntimeConfigSnapshot({});
      const job: CronStoredJob = {
        ...makeCronJob({ enabled: false }),
        operatorSource: {
          executionRevision: "fixture-revision",
          source: decodeGatewayOperatorRecoverySource(JSON.parse(serializedSource)),
        },
      };
      const storePath = path.join(stateDir, "cron", "jobs.json");
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      fixture.context.cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: () => {},
        runIsolatedAgentJob: async () => ({ status: "ok" }),
      });
      await fixture.context.cron.list({ includeDisabled: true });
      const restored = await captureCronJobTurnTarget({
        job,
        agentId: fixture.target.agentId,
        sessionKey: fixture.target.sessionKey,
        context: fixture.context,
      });
      const event = buildSessionEventContext({
        cfg: {},
        agentId: fixture.target.agentId,
        sessionKey: fixture.target.sessionKey,
        text: "Repair the scheduled automation.",
        options: { source: "cron_failure_repair" },
        occurrenceId: "native-cron-owner-repair",
        target: restored.target,
        assertCurrent: () => {},
      });
      const owner = expectDefined(getCommandOwnerAuthority(event), "restored cron owner");
      const authority = expectDefined(
        owner.operatorAuthority,
        "restored native operator authority",
      );
      expect(owner.isCurrent()).toBe(true);
      const client = createSyntheticPluginRuntimeClient({
        authenticatedUserProfile: fixture.client.authenticatedUserProfile,
        operatorRoleActor: { kind: "operator", profileId: authority.profileId },
        operatorRunAuthority: authority,
        scopes: ["operator.write"],
      });
      const child = expectDefined(
        await withPluginRuntimeGatewayRequestScope(
          { client, context: fixture.context, isWebchatConnect: () => false },
          () =>
            withOperatorToolGatewayAuthority(
              { operatorRunAuthority: authority, scopes: ["operator.write"] },
              async () => await captureOperatorToolGatewayContinuationContext(),
            ),
        ),
        "accepted child authority",
      );
      const beforeWrite = createDeferredCore();
      const releaseWrite = createDeferredCore();
      let pauseWrite = false;
      let writes = 0;
      let pendingWrite: Promise<unknown> | undefined;
      let admission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
      let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
      try {
        const runId = "recovered-child-effect";
        const { agentId, sessionKey, sessionId } = fixture.target;
        const prepared = prepareAgentRunAdmission({
          cfg: {},
          facts: {
            runId,
            agentId,
            ingress: { kind: "system", boundary: "recovered-child-test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(runId),
          operatorAuthority: child.operatorAuthority,
        });
        admission = prepared;
        const admittedRunContext = await child.run(() =>
          prepared.admit("plugin-harness", `harness-${runId}`),
        );
        bindGatewayContextResolver(admittedRunContext, () => fixture.context);
        host = child.run(() =>
          createAgentHarnessHostCapabilities({
            attempt: { runId, agentId, sessionKey, sessionId, admittedRunContext },
            pluginId: "codex",
          }),
        );
        const tool = expectDefined(
          host.capabilities.bindToolSurface([
            createWriteTool(stateDir, {
              operations: {
                mkdir: async (dir) => {
                  await mkdir(dir, { recursive: true });
                  if (pauseWrite) {
                    beforeWrite.resolve();
                    await releaseWrite.promise;
                  }
                },
                readFile,
                statFile: (file) => readPersistedFileStat(file, isMissingPathError),
                writeFile: async (file, content) => {
                  writes += 1;
                  await writeFile(file, content, "utf8");
                },
              },
            }),
          ])[0],
          "child write capability",
        );
        const file = "recovered-child-effect.txt";
        // The accepted child retains the cron source independently of this producer's hold.
        restored.release();
        expect(child.operatorAuthority?.scopes).toEqual(["operator.write"]);
        await child.run(() => tool.execute("allowed", { path: file, content: "allowed\n" }));
        expect(await readFile(path.join(stateDir, file), "utf8")).toBe("allowed\n");

        // No cancellation signal: the final write must revalidate its admitted principal.
        pauseWrite = true;
        pendingWrite = child.run(() =>
          tool.execute("revoked", { path: file, content: "forbidden\n" }),
        );
        void pendingWrite.catch(beforeWrite.reject);
        await beforeWrite.promise;
        if (change === "device revocation") {
          invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
        } else {
          const other = ensureProfileForEmail("other@example.test");
          linkEmail("recovery@example.test", other.id);
          if (change === "email restoration") {
            expect(linkEmail("recovery@example.test", profile.id).id).toBe(profile.id);
          }
        }
        releaseWrite.resolve();
        await expect(pendingWrite).rejects.toThrow("no longer active");
        expect(writes).toBe(1);
        expect(await readFile(path.join(stateDir, file), "utf8")).toBe("allowed\n");
        expect(child.signal.aborted).toBe(true);
      } finally {
        releaseWrite.resolve();
        await pendingWrite?.catch(() => undefined);
        host?.close();
        admission?.close();
        child.release();
        restored.release();
      }
    }),
);
