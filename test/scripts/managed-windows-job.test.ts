import assert from "node:assert/strict";
import { ChildProcess, spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { spawnWindowsJobChild } from "../../scripts/lib/managed-windows-job.mts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("@openclaw/proc-safe/windows-job", () => ({
  isSupported: () => true,
  WindowsJob: { create: () => ({ close: () => {}, terminate: () => {} }) },
}));

it("snapshots command inputs and preserves native startup errors through launcher IPC", async () => {
  const result = spawnSync(`${process.execPath}.absent`, []);
  const failure: NodeJS.ErrnoException | undefined = result.error;
  assert(failure, "Expected native missing-command failure");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const child = new ChildProcess();
  const send = (child.send = vi.fn((_message: unknown, _callback?: unknown) => true));
  mocks.spawn.mockReturnValue(child);
  const args = ["original"];
  const env = { NODE_OPTIONS: "upper", Node_Options: "mixed", VALUE: "original" };
  const { message, code, errno, syscall, path } = failure;
  const details = { code, errno, syscall, path };
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const owned = spawnWindowsJobChild("fixture", args, { env, stdio: "pipe" });
    args[0] = "mutated";
    env.VALUE = "mutated";
    child.emit("message", { job: mocks.spawn.mock.calls[0]?.[1][1], type: "ready" });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      command: "fixture",
      args: ["original"],
      options: { env: { ...env, VALUE: "original" } },
    });
    expect(send.mock.calls[0]?.[1]).toBeTypeOf("function");
    expect(mocks.spawn.mock.calls[0]?.[2].env).toEqual({ VALUE: "original" });
    child.emit("message", {
      job: mocks.spawn.mock.calls[0]?.[1][1],
      type: "error",
      error: message,
      ...details,
    });
    await expect(owned?.job.ready).rejects.toMatchObject({ message, ...details });
    owned?.job.close();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
