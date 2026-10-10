import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { closeOpenClawStateDatabaseByPath } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

it("starts the real source heartbeat from a foreign cwd using the selected tsconfig", async () => {
  await withOpenClawTestState({ label: "heartbeat-source-cwd" }, async (state) => {
    const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
    closeOpenClawStateDatabaseByPath(databasePath);
    await withTempDir("heartbeat-source-cwd-", async (cwd) => {
      const leaseModule = new URL("./openclaw-state-lease.ts", import.meta.url).href;
      const databaseModule = new URL("./openclaw-state-db.ts", import.meta.url).href;
      const script = `
        import assert from "node:assert/strict";
        import { withOpenClawStateLease } from ${JSON.stringify(leaseModule)};
        import { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } from ${JSON.stringify(databaseModule)};
        try {
          await withOpenClawStateLease({
            scope: "core:heartbeat-source-cwd", key: "source",
            database: { scope: "shared", options: { env: process.env } },
            leaseMs: 10000, waitMs: 0, heartbeat: "worker",
          }, async (lease) => { lease.assertOwned(); });
          const { db } = openOpenClawStateDatabase({ env: process.env });
          assert.equal(db.prepare("SELECT count(*) AS n FROM state_leases WHERE scope = ?")
            .get("core:heartbeat-source-cwd").n, 0);
          console.log("heartbeat settled");
        } finally { closeOpenClawStateDatabaseForTest(); }
      `;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
          "--input-type=module",
          "--eval",
          script,
        ],
        {
          cwd,
          env: {
            ...state.env,
            TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
          },
          timeout: 30000,
        },
      );
      expect(stdout.trim()).toBe("heartbeat settled");
    });
  });
});
