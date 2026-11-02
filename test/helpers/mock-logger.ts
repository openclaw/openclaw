import { vi, type Mock } from "vitest";

export function createInfoWarnErrorLogger(): { info: Mock; warn: Mock; error: Mock } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function createSilentPluginLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

export function createInfoWarnErrorDebugLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

export function createInfoErrorLogger(): { info: Mock; error: Mock } {
  return {
    info: vi.fn(),
    error: vi.fn(),
  };
}
