// Free-memory readings for cron tests: automation admission sizes run slots from them.
import { vi } from "vitest";
import * as hostMemory from "../../../src/infra/host-memory.js";
import * as childMemory from "../../../src/process/child-memory.js";

/**
 * Stands in for the host's free memory, with no container limit and no exec memory budget; run
 * slots read all three. On Linux the exec budget would otherwise come from the test host's cgroup.
 */
export function stubFreeMemory(bytes: number) {
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(hostMemory, "readCgroupMemoryHeadroomBytes").mockReturnValue(undefined);
  vi.spyOn(childMemory, "readHostExecMemory").mockReturnValue(undefined);
  vi.spyOn(hostMemory, "readHostFreeMemoryBytes").mockReturnValue(bytes);
}
