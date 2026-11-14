import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

const { bindExecutionGuards, executionParams, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");
const directories = useAutoCleanupTempDirTracker(afterAll);

describe("family admission precedes mutable update preparation", () => {
  const fixtures = new Map<string, string>();
  beforeAll(async () => {
    const root = directories.make("update-family-order-");
    for (const route of ["package", "git"]) {
      const directory = path.join(root, route);
      fixtures.set(route, directory);
      await fs.mkdir(path.join(directory, "leases"), { recursive: true });
      await writeFixtureJson(path.join(directory, "package.json"), {
        version: "2026.10.16",
        packageManager: "pnpm@12.10.1",
        openclaw: { databaseEngines: ["sqlite", "postgres"] },
      });
    }
  });

  it.each(["package", "git"] as const)(
    "refuses a global-PG-only %s candidate before prepare, stop or capture",
    async (route) => {
      const root = fixtures.get(route)!;
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(
        path.join(root, "leases"),
      );
      const env = { OPENCLAW_STATE_DIR: root };
      const config = { database: { families: { workboard: { engine: "sqlite" as const } } } };
      const context = {
        ...schemaContext("invoker"),
        env,
        readEnv: env,
        config,
        configSnapshot: createTestConfigSnapshot(config, config, path.join(root, "openclaw.json")),
      };
      mocks.captureSchemaContext.mockResolvedValue(context);
      mocks.captureManagedPreflight.mockResolvedValue(undefined);
      const { runId } = createUpdateRun({ trigger: "cli" }, { env });
      let published = false;
      const candidate = async (options: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        await options.validateCandidate!(root);
        published = true;
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(candidate);
      mocks.runGitUpdate.mockImplementation(async (options) => {
        await options.inspectGitTarget?.({ databaseEngines: ["sqlite", "postgres"] });
        return candidate(options);
      });
      const result = await withUpdateCommandExecutor(runId, async () =>
        executeMutableUpdate(
          await bindExecutionGuards({
            ...executionParams(route),
            root,
            shouldRestart: false,
            opts: { json: true, restart: false, run: { runId, env } },
          }),
        ),
      );
      expect(
        result?.result,
        result?.failure?.cause instanceof Error
          ? result.failure.cause.stack
          : result?.failure?.detail,
      ).toMatchObject({
        status: "error",
        reason: "database-engine-preflight",
      });
      expect(result?.failure?.detail).toContain(
        "the candidate did not prove support for database.families",
      );
      expect(published).toBe(false);
      expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.validateCanary).not.toHaveBeenCalled();
    },
  );
});
