import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.js";
import { readWindowsProcessArgsSync } from "../infra/windows-port-pids.js";
import { readWindowsProcessSnapshot } from "./schtasks-process-snapshot.js";
import { findInstalledProcessPid } from "./schtasks-process.js";

it.skipIf(process.platform !== "win32")(
  "matches a live process with literal Unicode argv through both Windows process readers",
  async (context) => {
    const lifetime = createFixtureLifetime();
    context.onTestFinished(() => lifetime.cleanup());
    return lifetime.run(async () => {
      const directory = lifetime.createTempDir("openclaw-cim-réseau-网卡-🚀-%%-^!-");
      const script = path.join(directory, "gateway-é.mjs");
      await fs.writeFile(
        script,
        'process.send(process.argv); process.on("message", () => process.exit(0));\n',
      );
      const programArguments = [
        process.execPath,
        script,
        "gateway",
        "--port",
        "18789",
        "réseau 网卡 🚀 e\u0301",
        'Office "A"',
        "C:\\Team Notes\\",
        "",
        "%%PATH%% ^!value!",
        "first\r\nsecond",
        "tail\r\n",
      ];
      context.signal.throwIfAborted();
      const child = spawn(process.execPath, programArguments.slice(1), {
        env: resolveDiagnosticProcessEnv(),
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        windowsHide: true,
      });
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      try {
        const [actualArguments] = await once(child, "message", { signal: context.signal });
        expect(actualArguments).toEqual(programArguments);
        if (child.pid === undefined) {
          throw new Error("The native argv fixture has no process identity");
        }
        const snapshot = readWindowsProcessSnapshot();
        if (!snapshot) {
          throw new Error("The native Windows process snapshot is unavailable");
        }
        expect(findInstalledProcessPid(snapshot, 18789, programArguments, () => true)).toBe(
          child.pid,
        );
        expect(readWindowsProcessArgsSync(child.pid)).toEqual(programArguments);
        expect(
          findInstalledProcessPid(
            snapshot,
            18789,
            [...programArguments.slice(0, -1), "different"],
            () => true,
          ),
        ).toBeNull();
      } finally {
        await lifetime.verifyCleanup(async () => {
          await stopChildProcess(child, 5_000);
          await closed;
        });
      }
    });
  },
  30_000,
);
