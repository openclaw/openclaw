import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import {
  continuePostCoreUpdateInFreshProcess,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("carries Doctor restoration phase and next action through the post-core child result", async () => {
  const root = tempDirs.make("post-core-doctor-failure-");
  const recordedPath = path.join(root, "failure.json");
  const facts = [
    {
      check: "gateway-restoration",
      code: "doctor-gateway-rpc-verification-failed",
      message: "rpc-verification: installed candidate did not answer",
    },
    {
      check: "gateway-restoration",
      code: "stale-gateway-recovery-command",
      message: "openclaw gateway status --deep",
    },
  ];
  const error = new UpdateDoctorError("Doctor Gateway restoration failed", facts);
  await writePostCoreUpdateFailureFile(
    recordedPath,
    new AggregateError(
      [new Error("finalization failed"), error],
      "Finalization and restoration failed",
    ),
  );
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "9999.1.1" }),
  );
  await fs.writeFile(
    path.join(root, "dist", "entry.mjs"),
    `import fs from "node:fs/promises"; await fs.copyFile(${JSON.stringify(recordedPath)}, process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH); process.exitCode = 1;`,
  );

  const result = await continuePostCoreUpdateInFreshProcess({
    root,
    channel: "stable",
    requestedChannel: null,
    opts: { json: true, yes: true },
    pluginInstallRecords: {},
    updateStartedAtMs: Date.now(),
    timeoutMs: 5000,
    nodeRunner: process.execPath,
  });

  expect(result).toMatchObject({
    resumed: false,
    exitCode: 1,
    error: expect.stringContaining("Doctor Gateway restoration failed"),
    failureFacts: facts,
  });
});
