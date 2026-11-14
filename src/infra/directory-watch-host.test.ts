import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { watchDirectory } from "./directory-watch-host.js";
import { observeOwnedDirectory } from "./owned-directory-observation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe("directory watch host", () => {
  it("keeps observation recoverable when helper startup throws", async () => {
    vi.spyOn(childProcess, "spawn").mockImplementationOnce(() => {
      throw new Error("synthetic helper startup failure");
    });
    syncBuiltinESMExports();
    const unavailable = Promise.withResolvers<void>();
    const observation = observeOwnedDirectory(tempDirs.make("directory-watch-startup-"), () =>
      unavailable.resolve(),
    );
    try {
      await unavailable.promise;
      expect(observation.isWatching()).toBe(false);
    } finally {
      observation.close();
    }
  });

  it("releases retired Windows handles while other watches remain live", async () => {
    const helper = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
        "--input-type=module",
        "--eval",
        `import fs from "node:fs";
        import { EventEmitter } from "node:events";
        Object.defineProperty(process, "platform", { value: "win32" });
        process.argv[2] = String(process.ppid);
        fs.watch = () => Object.assign(new EventEmitter(), {
          close() { process.stdout.write("closed\\n"); }
        });
        await import(${JSON.stringify(new URL("./directory-watch-host.worker.ts", import.meta.url).href)});`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let output = "";
    const processed = Promise.withResolvers<void>();
    helper.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes('"id":2,"event":"change"')) {
        processed.resolve();
      }
    });
    try {
      helper.stdin.write('{"id":1,"path":"first"}\n{"id":1}\n{"id":2,"path":"second"}\n');
      await processed.promise;
      expect(output).toContain("closed\n");
    } finally {
      helper.stdin.end();
      await once(helper, "exit");
    }
  });

  it("keeps native directory watchers out of the caller while forwarding their events", async () => {
    const root = tempDirs.make("directory-watch-host-");
    const watched = path.join(root, "watched");
    const retired = path.join(root, "retired");
    fs.mkdirSync(watched);
    fs.mkdirSync(path.join(watched, "nested"));
    fs.mkdirSync(retired);
    const nativeWatch = vi.spyOn(fs, "watch");
    const synchronousOpen = vi.spyOn(fs, "openSync");
    const synchronousStat = vi.spyOn(fs, "statSync");
    const synchronousAccess = vi.spyOn(fs, "accessSync");

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
    expect(synchronousOpen).not.toHaveBeenCalled();
    const lost = Promise.withResolvers<void>();
    fs.rmdirSync(retired);
    watchDirectory(retired, () => {}).on("error", () => lost.resolve());
    await lost.promise;

    const created = nextEvent(path.join("nested", "profiles"));
    fs.writeFileSync(path.join(watched, "nested", "profiles"), "after");
    synchronousOpen.mockClear();
    await expect(created).resolves.toEqual(["rename", path.join("nested", "profiles")]);

    // macOS retires native watches; enough move the live watch to a fresh helper.
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
    const handoff = process.platform === "darwin" ? nextEvent() : undefined;
    for (const sibling of siblings) {
      sibling.close();
    }
    if (handoff) {
      await expect(handoff).resolves.toEqual(["change", undefined]);
    }
    const moved = nextEvent(path.join("nested", "moved"));
    fs.writeFileSync(path.join(watched, "nested", "moved"), "after");
    synchronousOpen.mockClear();
    await expect(moved).resolves.toEqual(["rename", path.join("nested", "moved")]);
    watch.close();
    expect(nativeWatch).not.toHaveBeenCalled();
    expect(synchronousOpen).not.toHaveBeenCalled();
    expect(synchronousStat).not.toHaveBeenCalled();
    expect(synchronousAccess).not.toHaveBeenCalled();
  });

  it("observes missing nested roots and their replacements through asynchronous admission", async () => {
    const root = tempDirs.make("directory-watch-admission-");
    const directory = path.join(root, "new", "skills");
    const initial = Promise.withResolvers<void>();
    let expected = Promise.withResolvers<void>();
    let content = "first";
    const observation = observeOwnedDirectory(
      directory,
      () => {
        initial.resolve();
        void fs.promises.readFile(path.join(directory, "probe"), "utf8").then(
          (observed) => {
            if (observed === content) {
              expected.resolve();
            }
          },
          () => {},
        );
      },
      { recursive: true },
    );
    try {
      await initial.promise;
      for (const next of ["first", "replacement"]) {
        content = next;
        expected = Promise.withResolvers();
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(path.join(directory, "probe"), content);
        await expected.promise;
        if (next === "first") {
          await fs.promises.rename(directory, path.join(root, "retired"));
        }
      }
    } finally {
      observation.close();
    }
  });

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
