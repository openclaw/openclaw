import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withCliCommandCleanup, withCliProcessScope } from "../runtime-cleanup-scope.js";
import { runMutableUpdateRecovery } from "./update-command-mutable-signals.js";

const roots: string[] = [];
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("lets rollback acquire state ownership after a signal cancels the CLI's command work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-interrupted-recovery-"));
  roots.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  const acquire = () =>
    acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true, timeoutMs: 0 });
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      const resources = cleanup?.pluginResources;
      await resources?.run(async () => {
        resources.beginClose(new DOMException("CLI stopping (SIGTERM)", "AbortError"));
        expect(getAsyncWorkSignal()?.aborted).toBe(true);
        await expect(acquire()).rejects.toThrow("failed to acquire gateway state ownership");
        await runMutableUpdateRecovery(async () => {
          expect(getAsyncWorkSignal()?.aborted).toBe(false);
          const owner = await acquire();
          await owner?.release();
          expect(owner).toBeTruthy();
        });
      });
    }),
  );
});
