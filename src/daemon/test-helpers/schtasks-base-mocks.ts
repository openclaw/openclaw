import { vi } from "vitest";
import {
  inspectPortUsage,
  killProcessTree,
  schtasksCalls,
  schtasksThrownErrors,
  schtasksResponses,
} from "./schtasks-fixtures.js";

vi.mock("../schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    const thrown = schtasksThrownErrors.shift();
    if (thrown !== undefined) {
      throw thrown;
    }
    return schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("../../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: (pid: number, opts?: { graceMs?: number }) => killProcessTree(pid, opts),
}));
