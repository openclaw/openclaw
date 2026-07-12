// Public process-runtime SDK tests pin process-tree termination helpers.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "./test-node-mocks.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
    },
  );
});

import {
  forceKillChildProcessTree,
  shouldDetachChildForProcessTree,
  signalChildProcessTree,
} from "./process-runtime.js";

function expectTaskkillCall(index: number, args: string[]) {
  expect(spawnMock.mock.calls[index]).toStrictEqual([
    "taskkill",
    args,
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  ]);
}

describe("process-runtime process tree helpers", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => new EventEmitter());
  });

  it("exposes Windows process-tree signaling through the plugin SDK runtime subpath", async () => {
    await withMockedPlatform("win32", async () => {
      const child = { kill: vi.fn(), pid: 12345 };

      expect(shouldDetachChildForProcessTree()).toBe(false);
      signalChildProcessTree(child, "SIGTERM");
      forceKillChildProcessTree(child);

      expect(child.kill).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expectTaskkillCall(0, ["/T", "/PID", "12345"]);
      expectTaskkillCall(1, ["/F", "/T", "/PID", "12345"]);
    });
  });
});
