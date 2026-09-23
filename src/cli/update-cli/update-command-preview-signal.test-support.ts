import path from "node:path";
import { cronOwnerHardeningEntrypoints } from "../../cron/owner-hardening-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

export function createUpdatePreviewSignalScript(root: string, mode: string) {
  return `
      import fs from 'node:fs';
      import { registerSignalExitGate } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.signalExitBarrier).href)};
      import { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } from ${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)};
      import { createRetainedUpdateRecovery } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.retainedRecovery).href)};
      import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.stateDatabase).href)};
      import { admitUpdateCommandRun, withUpdatePreviewSignals } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandRun).href)};
      import { resolveUpdateCommandTarget } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandTarget).href)};
      const opts = { dryRun: true };
      const mode = ${JSON.stringify(mode)};
      if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
      const run = await admitUpdateCommandRun({ opts, root: ${JSON.stringify(root)}, installKind: "package" });
      await withUpdatePreviewSignals({ ...opts, run }, async () => {
        const sibling = createUpdateRun({ trigger: 'cli' });
        if (mode.startsWith('resolved')) {
          const foreign = () => recordUpdateRunPhase(run.runId, 'requested', { target: { tag: 'foreign' } });
          if (mode === 'resolved-foreign-before') foreign();
          const root = ${JSON.stringify(root)};
          await resolveUpdateCommandTarget({ ...opts, run }, { triageTarget: { root, env: run.env } }, undefined, {
            startedAt: Date.now(), postCoreUpdateResume: false, postCoreUpdateChannel: undefined,
            timeoutMs: 1000, shouldRestart: false, requestedChannel: null, devTarget: undefined,
            controlPlaneUpdateSentinelMeta: null, discoveredRoot: root, installKind: 'git',
            servicePlan: undefined,
          }, { enter: () => { throw new Error('preview must not acquire a mutable executor'); } }, 1000);
          if (mode === 'resolved-foreign-after') foreign();
        }
        if (mode === 'repeat') {
          registerSignalExitGate(new Promise((resolve) => process.once('message', resolve)));
          process.once('SIGINT', () => process.send('interrupted'));
        }
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'pending' || mode === 'missing') {
          const from = { root: ${JSON.stringify(root)}, nodePath: process.execPath, version: '1.0.0', buildId: null };
          createRetainedUpdateRecovery({ runId: run.runId, from, to: { ...from, version: '2.0.0' } }, { env: run.env });
        }
        if (mode === 'changed') recordUpdateRunPhase(run.runId, 'staging');
        if (mode === 'completed') finishUpdateRun(run.runId, { status: 'skipped', reason: 'dry-run' });
        const expected = getUpdateRun(run.runId);
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          const base = ${JSON.stringify(path.join(root, "state"))};
          const family = base + '/.openclaw-restore-00000000-0000-4000-8000-000000000001-0';
          fs.mkdirSync(family);
          fs.renameSync(base + '/openclaw.sqlite', family + '/displaced');
        }
        process.send({ runId: run.runId, expected, sibling });
        await new Promise(() => setInterval(() => {}, 1000));
      });
    `;
}
