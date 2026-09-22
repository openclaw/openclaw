import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { execFileUtf8 } from "./exec-file.js";
import { publishLaunchAgentPlist } from "./launchd-service-files.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";

vi.mock("./launchd-system.js", () => ({ assertNoSystemLaunchDaemonOwnership: async () => {} }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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

it("native plist publication rechecks after asynchronous preparation, without stale rollback", async () => {
  const root = dirs.make("native-plist-authority-");
  const plistPath = path.join(root, "test.plist");
  await fs.writeFile(plistPath, "original");
  let current = true;
  const originalWrite = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await originalWrite(...args);
    if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
      current = false;
    }
  });
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!current) {
          throw new Error("original update owner revoked");
        }
      },
      () =>
        publishLaunchAgentPlist({
          label: "ai.openclaw.native-test",
          plistPath,
          contents: "replacement",
        }),
    ),
  ).rejects.toThrow("original update owner revoked");
  expect(await fs.readFile(plistPath, "utf8")).toBe("original");
});

it("async work cannot retain an admitted native owner after command completion", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let late!: Promise<void>;
  await withGatewayServiceUpdateAuthority(
    () => {},
    async () => {
      late = ready.then(() => assertGatewayServiceUpdateCurrent());
    },
  );
  release();
  await expect(late).rejects.toThrow("has closed");
  expect(assertGatewayServiceUpdateCurrent).not.toThrow();
});
