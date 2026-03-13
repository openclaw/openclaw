import { vi } from "vitest";
import {
  inspectPortUsage,
  killProcessTree,
  schtasksCalls,
  schtasksResponses,
} from "./schtasks-fixtures.js";

vi.mock("../schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    return schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("../../infra/ports.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTree(...args),
}));
