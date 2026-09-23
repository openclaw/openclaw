import { execFile } from "node:child_process";
import fs from "node:fs";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { expect, it } from "vitest";
import { captureResourceOwnedNativeProcessExit } from "../infra/vitest-resource-ownership.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("closes cached handles on normal process exit so no stale WAL remains", async () => {
  await withOpenClawTestState({ label: "agent-db-normal-process-exit" }, async ({ stateDir }) => {
    const agentModuleUrl = new URL("./openclaw-agent-db.ts", import.meta.url).href;
    let settleNativeExit: (() => Promise<void>) | undefined;
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
          import fs from "node:fs";
          import { openOpenClawAgentDatabase } from ${JSON.stringify(agentModuleUrl)};

          const database = openOpenClawAgentDatabase({
            agentId: "worker-1",
            env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_AGENT_DB_EXIT_TEST_DIR },
          });
          const walPath = database.path + "-wal";
          console.log(JSON.stringify({
            agentDatabasePath: database.path,
            agentWalBytesBeforeExit: fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
          }));
        `,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_AGENT_DB_EXIT_TEST_DIR: stateDir },
        },
        (error, stdout) => {
          void Promise.resolve()
            .then(() => settleNativeExit?.())
            .then(
              () => {
                if (error) {
                  reject(toErrorObject(error, "Child process failed"));
                } else {
                  resolve(stdout);
                }
              },
              (cleanupError: unknown) => {
                reject(
                  error
                    ? new AggregateError(
                        [error, cleanupError],
                        "Child execution and native exit receipt failed",
                        { cause: cleanupError },
                      )
                    : toErrorObject(cleanupError, "Native child exit receipt failed"),
                );
              },
            );
        },
      );
      if (child.pid !== undefined) {
        settleNativeExit = captureResourceOwnedNativeProcessExit(child, {
          includeWorkerThreads: true,
        });
      }
    });
    const result = JSON.parse(output) as {
      agentDatabasePath: string;
      agentWalBytesBeforeExit: number;
    };
    if (result.agentWalBytesBeforeExit === 0) {
      // Rollback-journal filesystems (NFS/SMB tmp dirs) never produce a WAL.
      return;
    }
    // The child never closes explicitly; only the exit hook can retire the WAL.
    const walPath = `${result.agentDatabasePath}-wal`;
    const walBytesAfterExit = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    expect(walBytesAfterExit).toBe(0);
  });
});
