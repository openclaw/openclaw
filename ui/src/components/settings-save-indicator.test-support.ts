import { vi } from "vitest";
import type { SettingsSaveIndicatorProps as Props } from "./settings-save-indicator.tsx";

const activePresentation = new Promise<void>(() => {});

export function saveIndicatorProps(overrides: Partial<Props> = {}): Props {
  return {
    status: "idle",
    lastError: null,
    needsApply: false,
    saving: false,
    applying: false,
    applyDisabled: false,
    presentationRetired: () => activePresentation,
    onRetry: vi.fn(async () => false),
    onSave: vi.fn(async () => false),
    onReload: vi.fn(async () => undefined),
    onApply: vi.fn(async () => false),
    ...overrides,
  };
}
