import { EventEmitter } from "node:events";
import { vi } from "vitest";

export const updateCliProcessMocks = {
  nodeVersionSatisfiesEngine: vi.fn(),
  resolveNodeRuntimeInfo:
    vi.fn<(typeof import("../../daemon/runtime-paths.js"))["resolveNodeRuntimeInfo"]>(),
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function") {
      callback(null, new Date(Date.now() - 1000).toString(), "");
    }
    return new EventEmitter();
  }),
  spawn: vi.fn(),
};
