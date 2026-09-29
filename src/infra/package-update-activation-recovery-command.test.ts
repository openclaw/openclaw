import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
} from "./package-update-activation.js";

const fixture = createPackageActivationLifetimeFixture();
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

it.skipIf(process.platform === "win32")(
  "replays the pending receipt with the validated Node when PATH has no node",
  () =>
    fixture.lifetime.run(async () => {
      const { root, childGuardEnv } = fixture.setup();
      // This fixture helper records command delivery; publication/recovery behavior
      // is exercised by the existing activation lifetime and runtime tests.
      fs.writeFileSync(
        path.join(root, "sealed.mjs"),
        "console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}));\n",
      );
      const prepared = await fixture.prepare();
      const command = readPackageActivationReceipt(prepared.packageRoot)?.recoveryCommand;
      if (!command) {
        throw new Error("Pending activation did not expose recovery");
      }
      expect(() => assertNoPendingPackageActivation(prepared.packageRoot)).toThrow(command);
      const emptyPath = path.join(root, "empty-path");
      fs.mkdirSync(emptyPath, { mode: 0o700 });
      const result = spawnSync("/bin/sh", ["-c", command], {
        env: childGuardEnv({ ...process.env, PATH: emptyPath }),
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        node: fs.realpathSync(process.execPath),
        args: ["--anchor", prepared.anchor, "--operation", prepared.operationId, "status"],
      });
    }),
);
