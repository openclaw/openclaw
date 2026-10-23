import { vi } from "vitest";
import type { ChatMobileHost } from "./chat-mobile-host.ts";

export function createChatMobileHostFixture(
  scopeKey: string,
  overrides: Partial<Omit<ChatMobileHost, "scopeKey">> = {},
): ChatMobileHost {
  return {
    scopeKey,
    open: false,
    suspended: false,
    mode: "dock",
    height: undefined,
    reservedHeight: 0,
    destination: { area: "panels" },
    detailsMount: null,
    setDetailsMount: vi.fn(),
    navigate: vi.fn(),
    reveal: vi.fn(),
    close: vi.fn(),
    back: vi.fn(),
    toggleExpanded: vi.fn(),
    resize: vi.fn(),
    keyboardVisible: false,
    onComposerEditingChange: vi.fn(),
    ...overrides,
  };
}
