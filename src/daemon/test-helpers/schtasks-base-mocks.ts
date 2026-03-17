import { vi } from "vitest";
import {
  inspectPortUsage,
  schtasksCallOptions,
  killProcessTree,
  schtasksCalls,
  schtasksResponses,
} from "./schtasks-fixtures.js";

vi.mock("../schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[], options?: { signal?: AbortSignal }) => {
    schtasksCalls.push(argv);
    schtasksCallOptions.push(options);
    return schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("../../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: (pid: number, opts?: { graceMs?: number }) => killProcessTree(pid, opts),
}));
