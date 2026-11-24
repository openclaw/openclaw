import { vi } from "vitest";
import type { ChatMobileHost } from "./chat-mobile-host.ts";
import type { ChatDetailsMobilePage } from "./components/chat-details-mobile-content.tsx";

export function createChatMobileHostFixture(
  scopeKey: string,
  overrides: Partial<Omit<ChatMobileHost, "scopeKey">> = {},
): ChatMobileHost {
  return {
    scopeKey,
    open: false,
    exiting: false,
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

export function createMobileRootContentFixture(): Extract<
  ChatDetailsMobilePage,
  { kind: "root" }
>["content"] {
  return {
    entries: {
      labels: {
        people: "People",
        taskProgress: "Task progress",
        subagents: "Subagents",
        environment: "Environment",
        context: "Context",
        pullRequests: "Pull requests",
        automations: "Automations",
        generatedFiles: "Generated files",
        session: "Session",
      },
      people: { label: "People" },
      versions: { label: "Versions", metadata: 1 },
      onNavigate: vi.fn(),
    },
    processes: undefined,
    subagents: { workingLabel: "Working", onOpenSubagent: vi.fn(), onOpenSubagents: vi.fn() },
  };
}
