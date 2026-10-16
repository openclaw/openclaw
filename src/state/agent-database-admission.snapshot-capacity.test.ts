import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteReadOnlyInspectionFailure } from "../infra/sqlite-error-diagnostics.js";
import { sqliteSnapshotStagingError } from "../infra/sqlite-snapshot-staging.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "./agent-database-admission.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { code: "ENOSPC", capacity: true },
  { code: "EDQUOT", capacity: true },
  { code: "ERR_SQLITE_ERROR", errcode: 13, capacity: true },
  { code: "ERR_SQLITE_ERROR", errcode: 11, capacity: false },
])("keeps candidate snapshot $code remediation off serving schemas", async (failure) => {
  const root = fs.realpathSync(dirs.make("candidate-snapshot-admission-"));
  const cause = sqliteSnapshotStagingError(
    root,
    Object.assign(new Error("synthetic snapshot failure"), failure),
  );
  const reason = `SQLite read-only worker ${formatSqliteReadOnlyInspectionFailure(cause)}`;
  await withEnvAsync(
    {
      ...buildUpdateRehearsalPathEnv(root),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
    },
    async () => {
      const error = new AgentDatabaseAdmissionError(
        createAgentDatabaseInspectionRefusal({ agentId: "main", paths: [], reason, cause }),
      );
      expect(error.message.includes("doctor --fix")).toBe(!failure.capacity);
      if (failure.capacity) {
        expect(error.message).toContain("retry the update");
      }
    },
  );
});
