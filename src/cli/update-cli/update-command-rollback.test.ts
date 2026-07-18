// Rollback arming tests use an isolated service state directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readUpdateRollbackTransaction } from "../../infra/update-rollback.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { armManagedServiceUpdateRollback } from "./update-command-rollback.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("managed service update rollback arming", () => {
  it("writes a pending transaction only for an enabled retained package", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-arm-rollback-"));
    temporaryRoots.push(root);
    const serviceEnv = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    const result: UpdateRunResult = {
      status: "ok",
      mode: "npm",
      root: path.join(root, "current"),
      before: { version: "1.9.0" },
      after: { version: "2.0.0" },
      rollback: { retainedPackageRoot: path.join(root, "retained") },
      steps: [],
      durationMs: 1,
    };

    await armManagedServiceUpdateRollback({
      enabled: true,
      result,
      currentRoot: result.root ?? "",
      gatewayPort: 19001,
      serviceEnv,
    });

    expect(await readUpdateRollbackTransaction(serviceEnv)).toMatchObject({
      state: "pending",
      newVersion: "2.0.0",
      previousVersion: "1.9.0",
      gatewayPort: 19001,
    });
    expect(
      await armManagedServiceUpdateRollback({
        enabled: false,
        result,
        currentRoot: result.root ?? "",
        gatewayPort: 19001,
        serviceEnv,
      }),
    ).toBeNull();
    expect(
      await armManagedServiceUpdateRollback({
        enabled: true,
        result: { ...result, status: "error" },
        currentRoot: result.root ?? "",
        gatewayPort: 19001,
        serviceEnv,
      }),
    ).toBeNull();
  });
});
