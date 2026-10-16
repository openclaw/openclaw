import { expect, it } from "vitest";
import { seedMacNodeWorkerProofState } from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { readDaemonRuntimePinMigrationPending } from "../daemon/runtime-pin-state.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { migrateDaemonRuntimePins } from "../infra/state-migrations.daemon-runtime-pins.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import { setupCommand } from "./setup.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

it.each(["gateway", "baseline setup", "non-interactive setup", "native bootstrap"])(
  "creates %s profiles without pending runtime-pin migration before the Gateway serves",
  async (creation) => {
    await withOpenClawTestState({ label: "fresh-runtime-pins" }, async (state) => {
      if (creation === "baseline setup") {
        await setupCommand(
          { workspace: state.workspaceDir, skipBootstrap: true },
          createTestRuntime(),
        );
      } else if (creation === "non-interactive setup") {
        await runNonInteractiveSetup(
          {
            workspace: state.workspaceDir,
            authChoice: "skip",
            installDaemon: false,
            skipHealth: true,
            skipChannels: true,
            skipSkills: true,
            skipSearch: true,
            skipUi: true,
            skipHooks: true,
            skipBootstrap: true,
          },
          createTestRuntime(),
        );
      } else {
        await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
        if (creation === "native bootstrap") {
          seedMacNodeWorkerProofState(resolveOpenClawStateSqlitePath(state.env));
        }
      }

      const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
      expect(ready.snapshot.valid).toBe(true);
      expect(readDaemonRuntimePinMigrationPending(state.env)).toBe(false);

      const owner = await acquireGatewayLock({ allowInTests: true, env: state.env, timeoutMs: 0 });
      expect(owner).not.toBeNull();
      try {
        expect(await migrateDaemonRuntimePins(state.env)).toEqual({ changes: [], warnings: [] });
        owner?.assertCurrent();
      } finally {
        await owner?.release();
      }
    });
  },
);
