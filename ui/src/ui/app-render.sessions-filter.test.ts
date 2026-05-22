/* @vitest-environment jsdom */

import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createAppViewState } from "./app-render.test-helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { SessionsProps } from "./views/sessions.ts";

const sessionsView = vi.hoisted(() => ({
  capturedProps: null as SessionsProps | null,
}));

vi.mock("../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: () => null,
    removeItem: () => {},
    setItem: () => {},
  }),
  getSafeSessionStorage: () => null,
}));

vi.mock("./icons.ts", () => ({
  icons: {},
}));

vi.mock("./views/chat.ts", () => ({
  renderChat: () => html`<div data-testid="chat"></div>`,
}));

vi.mock("./views/config-quick.ts", () => ({
  renderQuickSettings: () => html`<div data-testid="quick-settings"></div>`,
}));

vi.mock("./controllers/sessions.ts", () => ({
  branchSessionFromCheckpoint: vi.fn(),
  deleteSessionsAndRefresh: vi.fn(),
  loadSessions: vi.fn(),
  patchSession: vi.fn(),
  restoreSessionFromCheckpoint: vi.fn(),
  toggleSessionCompactionCheckpoints: vi.fn(),
}));

// Drive the lazy sessions view synchronously and capture the props that
// app-render.ts builds for it, so the inline onFiltersChange / onClearFilters
// handler closures can be invoked directly.
vi.mock("./lazy-view.ts", () => ({
  createLazyView: () => ({}),
  renderLazyView: (_view: unknown, renderModule: (mod: unknown) => unknown) =>
    renderModule({
      renderSessions(props: SessionsProps) {
        sessionsView.capturedProps = props;
        return html`<div data-testid="sessions"></div>`;
      },
    }),
}));

import { renderApp } from "./app-render.ts";

// Render the app and return the props app-render.ts wired into the sessions
// view — including the real onFiltersChange / onClearFilters closures.
function captureSessionsProps(state: AppViewState): SessionsProps {
  sessionsView.capturedProps = null;
  renderApp(state);
  if (sessionsView.capturedProps === null) {
    throw new Error("renderApp did not render the sessions view");
  }
  return sessionsView.capturedProps;
}

describe("renderApp sessions filter persistence", () => {
  // Follow-up to PR #7: the persistSessionsFilter unit tests cover the helper
  // in isolation, but not that app-render.ts's inline handlers actually call
  // it. These render the real app and exercise that wiring end to end —
  // dropping the persistSessionsFilter(...) call from either handler fails here.
  it("wires onFiltersChange to persist the boolean toggles through applySettings", () => {
    const applySettings = vi.fn<(next: unknown) => void>();
    const props = captureSessionsProps(createAppViewState({ tab: "sessions", applySettings }));
    // Ignore any applySettings activity from the render pass itself.
    applySettings.mockClear();

    props.onFiltersChange({
      activeMinutes: "30",
      limit: "50",
      includeGlobal: false,
      includeUnknown: true,
      showArchived: false,
    });

    expect(applySettings).toHaveBeenCalledTimes(1);
    const persisted = applySettings.mock.calls[0]?.[0] as { sessionsFilter?: unknown };
    // The exact match also pins the contract that the numeric activeMinutes /
    // limit inputs stay session-scoped and never reach the persisted filter.
    expect(persisted.sessionsFilter).toEqual({
      includeGlobal: false,
      includeUnknown: true,
      showArchived: false,
    });
  });

  it("wires onClearFilters to persist the widened all-on toggles through applySettings", () => {
    const applySettings = vi.fn<(next: unknown) => void>();
    const props = captureSessionsProps(createAppViewState({ tab: "sessions", applySettings }));
    applySettings.mockClear();

    props.onClearFilters();

    expect(applySettings).toHaveBeenCalledTimes(1);
    const persisted = applySettings.mock.calls[0]?.[0] as { sessionsFilter?: unknown };
    expect(persisted.sessionsFilter).toEqual({
      includeGlobal: true,
      includeUnknown: true,
      showArchived: true,
    });
  });
});
