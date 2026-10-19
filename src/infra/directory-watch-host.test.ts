import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

      const events: Array<PromiseWithResolvers<[string, string | undefined]>> = [
        Promise.withResolvers(),
        Promise.withResolvers(),
      ];
      let received = 0;
      const watch = watchDirectory(
        watched,
        (event, filename) => {
          if (received++ === 0) {
            events[0]!.resolve([event, filename]);
          } else if (filename === path.join("nested", "profiles")) {
            events[1]!.resolve([event, filename]);
          }
        },
        true,
      );
      // Registration is asynchronous, so the live watch first invalidates the whole directory.
      await expect(events[0]!.promise).resolves.toEqual(["change", undefined]);
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

      fs.writeFileSync(path.join(watched, "nested", "profiles"), "after");
      await expect(events[1]!.promise).resolves.toEqual([
        "rename",
        path.join("nested", "profiles"),
      ]);
      watch.close();
      expect(nativeWatch).not.toHaveBeenCalled();
    },
  );
});
