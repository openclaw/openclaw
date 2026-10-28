import { vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { NewSessionDraft } from "./draft.ts";

export function createTestDraft(context: ApplicationContext) {
  return new NewSessionDraft(() => ({ context, data: undefined, isConnected: true }), {
    changed: vi.fn(),
    updateComplete: () => Promise.resolve(),
    closeTransientUi: vi.fn(),
    activeElement: () => null,
    onInvalidate: vi.fn(),
    onRecoveryReady: vi.fn(),
  });
}
