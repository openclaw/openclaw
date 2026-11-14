import fs from "node:fs";
import promises from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { waitForCommandProcessGroupExit } from "./exec-spawn.js";

afterEach(() => vi.restoreAllMocks());

it("keeps command-group exit observation responsive when negative PID probes are denied", async () => {
  mockProcessPlatform("linux");
  const group = 424242;
  const listing = createDeferredCore<Awaited<ReturnType<typeof promises.readdir>>>();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  const syncListing = vi.spyOn(fs, "readdirSync");
  const syncRead = vi.spyOn(fs, "readFileSync");
  const syncLink = vi.spyOn(fs, "readlinkSync");
  vi.spyOn(promises, "readlink").mockResolvedValue(String(process.pid));
  vi.spyOn(promises, "readdir").mockImplementation(() => listing.promise);
  const completed = vi.fn();
  const waiting = waitForCommandProcessGroupExit(group, () => true).then(completed);
  try {
    await setImmediate();
    // Pending asynchronous I/O must not prevent the event loop from serving other work.
    expect(completed).not.toHaveBeenCalled();
    expect(syncListing).not.toHaveBeenCalled();
    expect(syncRead).not.toHaveBeenCalled();
    expect(syncLink).not.toHaveBeenCalled();
  } finally {
    listing.resolve([]);
    await waiting;
  }
  expect(completed).toHaveBeenCalledWith("exited");
});
