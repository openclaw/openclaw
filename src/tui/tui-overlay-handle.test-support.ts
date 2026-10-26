import type { OverlayHandle } from "@earendil-works/pi-tui";
import { vi } from "vitest";

export function createOverlayHandle(): OverlayHandle {
  return {
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => true),
    getBounds: () => undefined,
  };
}
