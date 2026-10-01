import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { loadManagedChildSpawner } from "../../scripts/lib/managed-child-process.mts";
import { testing } from "./openclaw-test-instance.js";

const mocks = vi.hoisted(() => ({ spawnWindowsJobChild: vi.fn() }));
vi.mock("../../scripts/lib/managed-windows-job.mts", () => ({
  spawnWindowsJobChild: mocks.spawnWindowsJobChild,
}));
afterEach(() => vi.restoreAllMocks());

it("finalizes the native Job even when the Gateway and all output already closed", async () => {
  const child = new ChildProcess();
  Object.defineProperties(child, { pid: { value: 12345 }, exitCode: { value: 0 } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const closed = Promise.all([once(child.stdout, "close"), once(child.stderr, "close")]);
  child.stdout.destroy();
  child.stderr.destroy();
  await closed;
  const job = { inspect: () => [], beginStop: vi.fn(), stop: vi.fn(), close: vi.fn() };
  mocks.spawnWindowsJobChild.mockReturnValue({ child, job });
  const spawn = await loadManagedChildSpawner("win32");
  const gateway = spawn("fixture", [], { stdio: ["ignore", "pipe", "pipe"] });
  const taskkill = vi.fn();
  await expect(
    testing.stopGatewayProcess(gateway, Date.now() + 500, 250, {
      platform: "win32",
      runTaskkill: taskkill,
    }),
  ).resolves.toBe(true);
  expect(taskkill).not.toHaveBeenCalled();
  expect(job.close).toHaveBeenCalledOnce();
});
