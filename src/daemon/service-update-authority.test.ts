import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { execFileUtf8 } from "./exec-file.js";
import { resolveLaunchAgentPlistPath, writeLaunchAgentPlist } from "./launchd-service-files.js";
import {
  assertGatewayServiceFallbackAllowed as assertFallbackAllowed,
  assertGatewayServiceUpdateCurrent as assertUpdateCurrent,
  isUpdateOwnedGatewayServiceCommand as isUpdateOwned,
  readGatewayServiceUpdateOriginalRoot as readOriginalRoot,
  withGatewayServiceInstallationRecovery as recoverInstallation,
  withGatewayServiceUpdateAuthority as withUpdateAuthority,
} from "./service-update-authority.js";

vi.mock("./launchd-system.js", () => ({ assertNoSystemLaunchDaemonOwnership: async () => {} }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const retired = "fixture owner retired";
const doctorAuthority = { updateOwned: false, assertRecoveryCurrent: () => {} };
function asDoctor<T>(operation: () => Promise<T>, originalRoot?: string) {
  return withUpdateAuthority(assertUpdateCurrent, operation, { ...doctorAuthority, originalRoot });
}
const owner = {
  current: true,
  assertCurrent: (): void => {
    if (!owner.current) {
      throw new Error(retired);
    }
  },
  run<T>(operation: () => Promise<T>, options?: Parameters<typeof withUpdateAuthority>[2]) {
    return withUpdateAuthority(owner.assertCurrent, operation, options);
  },
};
beforeEach(() => {
  owner.current = true;
});

it("retains the live original installation through nested guards and compensation", async () => {
  await owner.run(
    () =>
      asDoctor(async () => {
        expect(readOriginalRoot()).toBe("/original-install");
        owner.current = false;
        expect(readOriginalRoot).toThrow(retired);
        owner.current = true;
        await expect(
          recoverInstallation(
            () => Promise.reject(new Error("installation failed")),
            async () => {
              expect(readOriginalRoot()).toBe("/original-install");
              return false;
            },
          ),
        ).rejects.toThrow("installation failed");
      }, "/replacement-install"),
    { originalRoot: "/original-install" },
  );
  expect(readOriginalRoot()).toBeUndefined();
});

it("retains recovery material when a native writer has not settled", async () => {
  vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue(
    createCommandResult({ cleanup: "uncertain" }),
  );
  const restore = vi.fn(async () => true);
  await expect(
    owner.run(() =>
      recoverInstallation(() => execFileUtf8(process.execPath, ["-e", "process.exit(0)"]), restore),
    ),
  ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  expect(restore).not.toHaveBeenCalled();
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])("native subprocess retains its owner (revoked=%s, nested=%s)", async (revoked, nested) => {
  const effect = path.join(dirs.make("native-authority-"), "effect");
  const parentGroup =
    process.platform === "win32" || revoked || nested
      ? undefined
      : spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
  if (parentGroup) {
    expect(parentGroup.status).toBe(0);
  }
  const run = owner.run(async () => {
    const invoke = async () => {
      await Promise.resolve();
      owner.current = !revoked;
      const result = await execFileUtf8(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(effect)},"owned");
          if (${parentGroup !== undefined}) process.stdout.write(require("node:child_process").spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {encoding: "utf8"}).stdout);`,
      ]);
      expect(result.code, result.stderr).toBe(0);
      if (parentGroup) {
        expect(result.stdout.trim()).toBe(parentGroup.stdout.trim());
      }
    };
    await (nested ? withUpdateAuthority(() => {}, invoke) : invoke());
  });
  if (revoked) {
    await expect(run).rejects.toThrow(retired);
    await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await run;
    expect(await fs.readFile(effect, "utf8")).toBe("owned");
  }
});

it.each([true, false])("retains Doctor compensation custody (%s)", async (updater) => {
  const ready = createDeferred();
  let late!: Promise<void>;
  const restore = vi.fn(async () => {
    expect(() => assertFallbackAllowed("detached launch")).toThrow("not an update-owned");
    late = ready.promise.then(() => {
      assertUpdateCurrent();
    });
    return true;
  });
  const install = () =>
    recoverInstallation(async () => {
      expect(isUpdateOwned()).toBe(updater);
      await Promise.resolve();
      owner.current = false;
    }, restore);
  await expect(
    owner.run(updater ? () => asDoctor(install) : install, updater ? undefined : doctorAuthority),
  ).rejects.toMatchObject({
    code: "service-authority-revoked",
    outcome: updater ? "recovery-pending" : "restored",
  });
  if (updater) {
    expect(restore).not.toHaveBeenCalled();
  } else {
    ready.resolve();
    await expect(late).rejects.toThrow("has closed");
  }
});

it("native plist publication rechecks after asynchronous preparation, without stale rollback", async () => {
  const env = { HOME: dirs.make("native-plist-authority-") };
  const plistPath = resolveLaunchAgentPlistPath(env);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, "original");
  const originalWrite = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await originalWrite(...args);
    owner.current = false;
  });
  await expect(
    owner.run(() =>
      writeLaunchAgentPlist({ env, stdout: process.stdout, programArguments: [process.execPath] }),
    ),
  ).rejects.toThrow(retired);
  expect(await fs.readFile(plistPath, "utf8")).toBe("original");
});

it.each([true, false])("closes retained guards and async work (update=%s)", async (updateOwned) => {
  const ready = createDeferred();
  let late!: Promise<void>;
  const retained = await withUpdateAuthority(
    undefined,
    async (assertCurrent) => {
      await Promise.resolve();
      assertCurrent();
      late = ready.promise.then(() => assertFallbackAllowed("late detached launch"));
      return assertCurrent;
    },
    { ...doctorAuthority, updateOwned },
  );
  expect(retained).toThrow("has closed");
  ready.resolve();
  await expect(late).rejects.toThrow("has closed");
  expect(assertUpdateCurrent).not.toThrow();
});
