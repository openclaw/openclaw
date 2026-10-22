import { vi } from "vitest";
import type { SubsystemLogger } from "../../src/logging/subsystem.js";

/** Supplies the full subsystem logger contract with caller-observed methods. */
export function createMockSubsystemLogger(
  subsystem: string,
  overrides: Partial<SubsystemLogger> = {},
): SubsystemLogger {
  const logger: SubsystemLogger = {
    subsystem,
    isEnabled: vi.fn(() => false),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(() => logger),
    ...overrides,
  };
  return logger;
}
