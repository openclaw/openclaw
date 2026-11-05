import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { watchDirectory } from "./directory-watch-host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("macOS directory watch host", () => {
  // Bun does not use libuv watchers, so the host only serves Node runtimes.
  it.skipIf(Boolean(process.versions.bun))(
    "keeps native directory watchers out of the caller while forwarding their events",
    async () => {
      // The helper runs anywhere; forcing darwin selects it on every CI host.
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      const root = tempDirs.make("directory-watch-host-");
      const watched = path.join(root, "watched");
      const retired = path.join(root, "retired");
      fs.mkdirSync(watched);
      fs.mkdirSync(path.join(watched, "nested"));
      fs.mkdirSync(retired);
      const nativeWatch = vi.spyOn(fs, "watch");
      expect(() => watchDirectory(path.join(root, "missing"), () => {})).toThrow();

      let expected: PromiseWithResolvers<[string, string | undefined]> & { filename?: string };
      const nextEvent = (filename?: string) => {
        expected = { ...Promise.withResolvers(), filename };
        return expected.promise;
      };
      // Registration is asynchronous, so the live watch first invalidates the whole directory.
      const registered = nextEvent();
      const watch = watchDirectory(
        watched,
        (event, filename) => {
          if (filename === expected.filename) {
            expected.resolve([event, filename]);
          }
        },
        true,
      );
      await expect(registered).resolves.toEqual(["change", undefined]);
      const lost = Promise.withResolvers<void>();
      const open = fs.openSync;
      // Retire after caller admission, before helper registration. Deleting a live
      // Linux watch emits rename rather than the registration error under test.
      vi.spyOn(fs, "openSync").mockImplementationOnce((...args) => {
        const fd = open(...args);
        fs.rmdirSync(retired);
        return fd;
      });
      watchDirectory(retired, () => {}).on("error", () => lost.resolve());
      await lost.promise;

      const created = nextEvent(path.join("nested", "profiles"));
      fs.writeFileSync(path.join(watched, "nested", "profiles"), "after");
      await expect(created).resolves.toEqual(["rename", path.join("nested", "profiles")]);

      // Closes only retire native watches; enough of them move the live watch to a
      // fresh helper, which invalidates it once and keeps forwarding its events.
      const siblings = await Promise.all(
        Array.from({ length: 64 }, async (_, index) => {
          const sibling = path.join(root, `sibling-${index}`);
          fs.mkdirSync(sibling);
          const live = Promise.withResolvers<void>();
          const siblingWatch = watchDirectory(sibling, () => live.resolve());
          await live.promise;
          return siblingWatch;
        }),
      );
      const handoff = nextEvent();
      for (const sibling of siblings) {
        sibling.close();
      }
      await expect(handoff).resolves.toEqual(["change", undefined]);
      const moved = nextEvent(path.join("nested", "moved"));
      fs.writeFileSync(path.join(watched, "nested", "moved"), "after");
      await expect(moved).resolves.toEqual(["rename", path.join("nested", "moved")]);
      watch.close();
      expect(nativeWatch).not.toHaveBeenCalled();
    },
  );

  // A watch close can hold the helper's loop on fseventsd long after its caller is
  // gone. A process that keeps the helper's pipes open models that unread input.
  it.skipIf(Boolean(process.versions.bun) || process.platform === "win32")(
    "exits after its caller dies even while its pipes stay open",
    async () => {
      const caller = spawn(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
          "--input-type=module",
          "--eval",
          `import childProcess from "node:child_process";
          import { syncBuiltinESMExports } from "node:module";
          const { spawn } = childProcess;
          let host;
          childProcess.spawn = (...args) => (host = spawn(...args));
          syncBuiltinESMExports();
          Object.defineProperty(process, "platform", { value: "darwin" });
          const { watchDirectory } = await import(${JSON.stringify(new URL("./directory-watch-host.ts", import.meta.url).href)});
          watchDirectory(process.argv[1], () => {});
          const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: [host.stdin, host.stdout, "ignore"],
            detached: true,
          });
          console.log(JSON.stringify({ host: host.pid, holder: holder.pid }));
          process.kill(process.pid, "SIGKILL");`,
          tempDirs.make("directory-watch-host-caller-"),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let output = "";
      caller.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
      await once(caller, "exit");
      const pids = JSON.parse(output) as { host: number; holder: number };
      try {
        await expect(waitForPidToExit(pids.host, 5_000)).resolves.toBe(true);
        expect(isPidAlive(pids.holder)).toBe(true);
      } finally {
        killPidIfAlive(pids.host);
        killPidIfAlive(pids.holder);
      }
    },
  );
});
