import { describe, expect, it, vi } from "vitest";
import { handleSessionLinkClick } from "../../ui/src/ui/session-link-click.ts";

function buildEvent(overrides: Partial<Parameters<typeof handleSessionLinkClick>[0]> = {}) {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("handleSessionLinkClick", () => {
  it("prevents default navigation and routes plain left-clicks through the app", () => {
    const event = buildEvent();
    const onSelectSession = vi.fn();

    const handled = handleSessionLinkClick(event, onSelectSession, "agent:main:session-123");

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onSelectSession).toHaveBeenCalledWith("agent:main:session-123");
  });

  it("leaves modified clicks alone so opening in a new tab still uses native browser behavior", () => {
    const event = buildEvent({ ctrlKey: true });
    const onSelectSession = vi.fn();

    const handled = handleSessionLinkClick(event, onSelectSession, "agent:main:session-123");

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});
