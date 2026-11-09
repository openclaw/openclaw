import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import * as json5 from "json5";
import { registerSealedRuntime } from "../../infra/sealed-runtime-registry.js";
import type { UpdateCommandChildGrant } from "./update-command-executor.js";

const reportPhase = (phase: string) => {
  process.stdout.write(
    JSON.stringify({ phase, pid: process.pid, elapsedMs: performance.now() }) + "\n",
  );
};
// SAFETY: The fixture sends private stdin only after binding this child; the real executor validates it.
const { grant, proceed } = JSON.parse(fs.readFileSync(0, "utf8")) as {
  grant: UpdateCommandChildGrant;
  proceed: string;
};
reportPhase("input-read");
const control = path.dirname(grant.databasePath);
// Register before effect owners can resolve and cache the process temp root.
registerSealedRuntime({ json5, resolveSecureTempRoot: () => control });
const { readConfigFileSnapshot } = await import("../../config/config.js");
const { formatErrorMessage } = await import("../../infra/errors.js");
const { persistRequestedUpdateChannel } = await import("./update-command-config.js");
const { withDelegatedUpdateCommandExecutor } = await import("./update-command-executor.js");
reportPhase("loaded");
const open = fsp.open;
let announced = false;
fsp.open = async (...args) => {
  const handle = await open(...args);
  if (!announced && String(args[0]).includes("openclaw-config-backup")) {
    announced = true;
    process.stdout.write(
      JSON.stringify({
        ready: true,
        pid: process.pid,
        parentPid: grant.parent.executor.pid,
        parentOwner: grant.parent.owner,
        candidate: import.meta.url,
      }) + "\n",
    );
    while (!fs.existsSync(proceed)) {
      await setTimeout(10);
    }
  }
  return handle;
};
try {
  await withDelegatedUpdateCommandExecutor(grant, grant.runId, grant.root, async (fence) => {
    reportPhase("executor-admitted");
    const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
    reportPhase("snapshot-read");
    const result = await persistRequestedUpdateChannel({
      configSnapshot: snapshot,
      requestedChannel: "beta",
      assertCurrent: fence.assertCurrent,
    });
    process.stdout.write(
      JSON.stringify({
        result: "published",
        channel: result.config.update!.channel,
        pid: process.pid,
      }) + "\n",
    );
  });
} catch (error) {
  process.stdout.write(
    JSON.stringify({ result: "refused", error: formatErrorMessage(error), pid: process.pid }) +
      "\n",
  );
  process.exitCode = 1;
}
