import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

const { register } = await import(workerData.sourceLoaderUrl);
register();
const { replaceConfigFile } = await import("../plugin-sdk/config-mutation.ts");
const { createConfigIO } = await import("./io.factory.ts");
const { loadDotEnv } = await import("../infra/dotenv.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.ts");

try {
  await replaceConfigFile({
    nextConfig: { gateway: { mode: "local", port: 19001 } },
    afterWrite: { mode: "none", reason: "SDK worker regression" },
  });
  assert.equal(JSON.parse(fs.readFileSync(workerData.configPath, "utf8")).gateway.port, 19001);
  fs.appendFileSync(
    path.join(path.dirname(workerData.configPath), ".env"),
    "CONFIG_WORKER_STAGED=isolated\n",
  );
  const stagedEnv = { ...process.env };
  loadDotEnv({ env: stagedEnv, quiet: true });
  assert.equal(stagedEnv.CONFIG_WORKER_STAGED, "isolated");
  assert.equal(process.env.CONFIG_WORKER_STAGED, undefined);

  fs.writeFileSync(
    workerData.configPath,
    JSON.stringify({ env: { vars: { CONFIG_WORKER_REVOKED: "stale" } } }),
  );
  let current = true;
  const revoked = new Error("Config worker authority revoked");
  const io = createConfigIO({
    fs: {
      ...fs,
      readFileSync: (...args) => {
        const result = fs.readFileSync(...args);
        if (args[0] === workerData.configPath) {
          current = false;
        }
        return result;
      },
    },
  });
  await assert.rejects(
    io.loadConfigAsync({
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
    }),
    (error) => error === revoked,
  );
  assert.equal(process.env.CONFIG_WORKER_REVOKED, undefined);
  parentPort.postMessage(
    { isMainThread, wroteConfig: true, isolatedDotEnv: true, rejectedStaleLoad: true },
    [],
  );
} finally {
  await closeOpenClawStateDatabaseAsync();
  parentPort.close();
}
