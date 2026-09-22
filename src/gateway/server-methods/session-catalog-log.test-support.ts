import { vi } from "vitest";
import type { SubsystemLogger } from "../../logging/subsystem.js";

const catalogLog = vi.hoisted(() => ({
  isEnabled: vi.fn<SubsystemLogger["isEnabled"]>(),
  warn: vi.fn<SubsystemLogger["warn"]>(),
}));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/session-catalog" ? { ...logger, ...catalogLog } : logger;
    },
  };
});

export { catalogLog };
