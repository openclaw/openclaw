import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { execFileUtf8 } from "./exec-file.js";
import { resolveLaunchAgentPlistPath, writeLaunchAgentPlist } from "./launchd-service-files.js";
import {
  assertGatewayServiceFallbackAllowed,
  assertGatewayServiceUpdateCurrent,
  isUpdateOwnedGatewayServiceCommand,
  withGatewayServiceInstallationRecovery,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";

vi.mock("./launchd-system.js", () => ({ assertNoSystemLaunchDaemonOwnership: async () => {} }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("retains recovery material when a native writer has not settled", async () => {
  vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    cleanup: "uncertain",
  });
  const restore = vi.fn(async () => true);
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {},
      () =>
        withGatewayServiceInstallationRecovery(
          () => execFileUtf8(process.execPath, ["-e", "process.exit(0)"]),
          restore,
        ),
    ),
  ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  expect(restore).not.toHaveBeenCalled();
});

it("a retained installer guard stays bound to its original closed scope", async () => {
  let retained!: () => void;
  await withGatewayServiceUpdateAuthority(
    undefined,
    async (assertCurrent) => {
      retained = assertCurrent;
      await Promise.resolve();
      assertCurrent();
    },
    { updateOwned: false, assertRecoveryCurrent: () => {} },
  );
  expect(() => retained()).toThrow("has closed");
});

it.skipIf(process.platform === "win32")(
  "native client retains its registered receiver process group",
  async () => {
    const parentGroup = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
    });
    expect(parentGroup.status).toBe(0);
    const result = await withGatewayServiceUpdateAuthority(
      () => {},
      () =>
        execFileUtf8(process.execPath, [
          "-e",
          `const {spawnSync}=require("node:child_process"); process.stdout.write(spawnSync("ps",["-o","pgid=","-p",String(process.pid)],{encoding:"utf8"}).stdout);`,
        ]),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(parentGroup.stdout.trim());
  },
);

it.each([false, true])("native subprocess refuses a revoked owner: revoked=%s", async (revoked) => {
  const root = dirs.make("native-authority-");
  const effect = path.join(root, "effect");
  let current = true;
  const run = withGatewayServiceUpdateAuthority(
    () => {
      if (!current) {
        throw new Error("original update owner revoked");
      }
    },
    async () => {
      await Promise.resolve();
      current = !revoked;
      const result = await execFileUtf8(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(effect)},"owned")`,
      ]);
      expect(result.code, result.stderr).toBe(0);
    },
  );
  if (revoked) {
    await expect(run).rejects.toThrow("original update owner revoked");
    await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await run;
    expect(await fs.readFile(effect, "utf8")).toBe("owned");
  }
});

it("Doctor compensation retains the original updater fence", async () => {
  let parentCurrent = true;
  const restore = vi.fn(async () => true);
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!parentCurrent) throw new Error("original updater retired");
      },
      () =>
        withGatewayServiceUpdateAuthority(
          assertGatewayServiceUpdateCurrent,
          () =>
            withGatewayServiceInstallationRecovery(async () => {
              expect(isUpdateOwnedGatewayServiceCommand()).toBe(true);
              await Promise.resolve();
              parentCurrent = false;
            }, restore),
          { updateOwned: false, assertRecoveryCurrent: () => {} },
        ),
    ),
  ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: "recovery-pending" });
  expect(restore).not.toHaveBeenCalled();
});

it("compensation closes with its callback and cannot grant an unmanaged fallback", async () => {
  let current = true;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let late!: Promise<void>;
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!current) throw new Error("Doctor custody released");
      },
      () =>
        withGatewayServiceInstallationRecovery(
          async () => {
            expect(isUpdateOwnedGatewayServiceCommand()).toBe(false);
            current = false;
          },
          async () => {
            expect(() => assertGatewayServiceFallbackAllowed("detached launch")).toThrow(
              "not an update-owned",
            );
            late = ready.then(() => {
              assertGatewayServiceUpdateCurrent();
            });
            return true;
          },
        ),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    ),
  ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: "restored" });
  release();
  await expect(late).rejects.toThrow("has closed");
});

it("native plist publication rechecks after asynchronous preparation, without stale rollback", async () => {
  const root = dirs.make("native-plist-authority-");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.native-test",
  };
  const plistPath = resolveLaunchAgentPlistPath(env);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, "original");
  let current = true;
  const originalWrite = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await originalWrite(...args);
    current = false;
  });
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!current) {
          throw new Error("original update owner revoked");
        }
      },
      () =>
        writeLaunchAgentPlist({
          env,
          stdout: process.stdout,
          programArguments: [process.execPath, "gateway"],
        }),
    ),
  ).rejects.toThrow("original update owner revoked");
  expect(await fs.readFile(plistPath, "utf8")).toBe("original");
});

it.each([true, false])(
  "async work cannot retain native authority after completion (update=%s)",
  async (updateOwned) => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: Promise<void>;
    await withGatewayServiceUpdateAuthority(
      () => {},
      async () => {
        late = ready.then(() => assertGatewayServiceFallbackAllowed("late detached launch"));
      },
      { updateOwned },
    );
    release();
    await expect(late).rejects.toThrow("has closed");
    expect(assertGatewayServiceUpdateCurrent).not.toThrow();
  },
);
