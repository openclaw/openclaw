import { createNodeEvalArgs } from "../test-utils/node-process.js";

const preparedWorkspaceChildScript = `
          import fs from 'node:fs';
          import { NodeWorkerWorkspaceRuntime } from './src/node-host/node-worker-workspace.ts';
          import { captureManifest, readWorkspaceManifest } from './src/node-host/node-worker-workspace-commands.ts';
          import { closeOpenClawStateDatabaseAsync } from './src/state/openclaw-state-db.ts';
          import { drainGlobalSingletonLifecycleState } from './src/shared/global-singleton.ts';
          try {
            const { action, input } = JSON.parse(fs.readFileSync(0, 'utf8'));
            if (action === 'capture') {
              const { manifest } = await readWorkspaceManifest(input.homeDir, input.preparedManifestRef);
              console.log(await captureManifest({
                workspaceDir: input.workspaceDir, manifestHome: input.homeDir,
                baseCommit: manifest.baseCommit, referenceManifestRef: input.preparedManifestRef,
                baseManifestRef: input.sourceManifestRef, hashMemo: new Map(),
              }));
            } else {
              await new NodeWorkerWorkspaceRuntime({ env: process.env, ephemeral: true }).prepare(input);
            }
          } catch (error) { console.error(error.message); process.exitCode = 1; }
          finally { await closeOpenClawStateDatabaseAsync(); await drainGlobalSingletonLifecycleState(); }
        `;

export const preparedWorkspaceChildArgs = createNodeEvalArgs(preparedWorkspaceChildScript, {
  imports: [
    "./scripts/tsx.mjs",
    "./src/node-host/node-worker-prepared-workspace.process.test-support.ts",
  ],
  evalFlag: "-e",
});
