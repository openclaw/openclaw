import { vi } from "vitest";
import type { SettingsSaveIndicatorProps as Props } from "./settings-save-indicator.tsx";

export function saveIndicatorProps(overrides: Partial<Props> = {}): Props {
  return {
    status: "idle",
    lastError: null,
    needsApply: false,
    applying: false,
    applyDisabled: false,
    onRetry: vi.fn(),
    onSave: vi.fn(),
    onReload: vi.fn(),
    onApply: vi.fn(),
    ...overrides,
  };
}
