import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";

const entrypoint = createTestEntrypoint(import.meta.url, "node-host");
const workspaceUrl = resolveRuntimeWorkerUrl(entrypoint("node-worker-workspace"));
const commandsUrl = resolveRuntimeWorkerUrl(entrypoint("node-worker-workspace-commands"));
const stateUrl = resolveRuntimeWorkerUrl(
  entrypoint("../state/openclaw-state-db", "state/openclaw-state-db.js"),
);
const singletonUrl = resolveRuntimeWorkerUrl(
  entrypoint("../shared/global-singleton", "shared/global-singleton.js"),
);

const preparedWorkspaceChildScript = `
          import fs from 'node:fs';
          import { NodeWorkerWorkspaceRuntime } from ${JSON.stringify(workspaceUrl.href)};
          import { captureManifest, readWorkspaceManifest } from ${JSON.stringify(commandsUrl.href)};
          import { closeOpenClawStateDatabaseAsync } from ${JSON.stringify(stateUrl.href)};
          import { drainGlobalSingletonLifecycleState } from ${JSON.stringify(singletonUrl.href)};
          try {
            const { action, input, deferRegistrationVerification = true } = JSON.parse(fs.readFileSync(0, 'utf8'));
            if (action === 'capture') {
              const { manifest } = await readWorkspaceManifest(input.homeDir, input.preparedManifestRef);
              console.log(await captureManifest({
                mode: "eligible",
                workspaceDir: input.workspaceDir, manifestHome: input.homeDir,
                baseCommit: manifest.baseCommit, referenceManifestRef: input.preparedManifestRef,
                baseManifestRef: input.sourceManifestRef, hashMemo: new Map(),
              }));
            } else {
              await new NodeWorkerWorkspaceRuntime({ env: process.env, ephemeral: true }).prepare(input, undefined, deferRegistrationVerification);
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
