import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";
import { handleGatewayProbeRequest } from "./server-http-probes.js";
import { createReadinessChecker } from "./server/readiness.js";

const originalExecPath = process.execPath;
const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  process.execPath = originalExecPath;
});
function checker() {
  return createReadinessChecker({
    startedAt: Date.now(),
    channelManager: {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
}
async function probe(
  getReadiness = checker(),
  request = createGatewayRequest({ path: "/readyz" }),
) {
  const response = createMockServerResponse();
  await handleGatewayProbeRequest(
    request,
    response,
    "/readyz",
    { mode: "none", allowTailscale: false },
    [],
    false,
    undefined,
    getReadiness,
  );
  return response;
}
it("serves repeated readyz probes without synchronous runtime filesystem checks", async () => {
  const readiness = checker();
  const spawnSync = vi.spyOn(childProcess, "spawnSync");
  syncBuiltinESMExports();
  using observation = observeMainThreadFs();
  try {
    expect((await probe(readiness)).statusCode).toBe(200);
    expect((await probe(readiness)).statusCode).toBe(200);
    expect(
      observation.stacks().filter(({ stack }) => stack.includes("child-runtime-viability.")),
    ).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  } finally {
    spawnSync.mockRestore();
    syncBuiltinESMExports();
  }
});
it.skipIf(process.platform === "win32")(
  "detects a missing runtime library before a child launch even while readiness is cached",
  async () => {
    const executable = path.join(directories.make("readiness-runtime-"), "node");
    await fs.writeFile(executable, "#!/bin/sh\necho v26.12.0\n", { mode: 0o700 });
    process.execPath = executable;
    const readiness = checker();
    expect((await probe(readiness)).statusCode).toBe(200);
    await fs.writeFile(
      executable,
      '#!/bin/sh\necho "node: error while loading shared libraries: libfixture.so: cannot open shared object file" >&2\nexit 127\n',
    );
    const response = await probe(readiness);
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body ?? "null")).toMatchObject({
      ready: false,
      failing: ["child-runtime"],
    });
  },
);

it("publishes current draining state after asynchronous runtime preparation", async () => {
  let draining = false;
  const readiness = createReadinessChecker({
    startedAt: Date.now(),
    getGatewayDraining: () => draining,
    channelManager: {
      getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
  const entered = createDeferred();
  const release = createDeferred();
  const prepare = readiness.prepare;
  using held = vi.spyOn(readiness, "prepare").mockImplementation(async () => {
    const prepared = await prepare();
    entered.resolve();
    await release.promise;
    return prepared;
  });
  const pending = probe(readiness);
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      "readiness did not prepare asynchronously",
    );
    expect(held).toHaveBeenCalledOnce();
    draining = true;
    release.resolve();
    const response = await pending;
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body ?? "null")).toMatchObject({ failing: ["gateway-draining"] });
  } finally {
    release.resolve();
    await pending;
  }
});

it.skipIf(process.platform === "win32")(
  "bounds concurrent readyz runtime work without sharing paths or caller cancellation",
  async () => {
    const alias = path.join(directories.make("readiness-runtime-alias-"), "node");
    await fs.symlink(originalExecPath, alias);
    const entered = createDeferred();
    const release = createDeferred();
    const execFile = childProcess.execFile;
    const launches = vi
      .spyOn(childProcess, "execFile")
      .mockImplementation((file, args, options, callback) =>
        execFile(file, args, options, (error, stdout, stderr) => {
          entered.resolve();
          void release.promise.then(() => callback?.(error, stdout, stderr));
        }),
      );
    syncBuiltinESMExports();
    const readiness = checker();
    const cancelledRequest = createGatewayRequest({ path: "/readyz" });
    const pending = [probe(readiness, cancelledRequest)];
    for (let index = 0; index < 7; index += 1) {
      pending.push(probe(readiness));
    }
    process.execPath = alias;
    for (let index = 0; index < 8; index += 1) {
      pending.push(probe(readiness));
    }
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        Promise.all(pending),
        "probe did not launch",
      );
      cancelledRequest.destroy();
      expect(launches.mock.calls.filter(([file]) => file === originalExecPath)).toHaveLength(1);
      expect(launches.mock.calls.filter(([file]) => file === alias)).toHaveLength(1);
      release.resolve();
      const responses = await Promise.all(pending);
      expect(responses.slice(1).every((response) => response.statusCode === 200)).toBe(true);
      // Only concurrent work is shared: a settled observation must not hide replacement.
      expect((await probe(readiness)).statusCode).toBe(200);
      expect(launches.mock.calls.filter(([file]) => file === alias)).toHaveLength(2);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      launches.mockRestore();
      syncBuiltinESMExports();
    }
  },
);
