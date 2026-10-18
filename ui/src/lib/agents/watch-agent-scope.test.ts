import { describe, expect, it, vi } from "vitest";
import { watchAgentScope } from "./watch-agent-scope.ts";

function selection(scopeId: string | null) {
  const listeners = new Set<(state: { scopeId: string | null }) => void>();
  const state = { scopeId };
  let intentRevision = 0;
  return {
    source: {
      state,
      get intentRevision() {
        return intentRevision;
      },
      subscribe(listener: (next: { scopeId: string | null }) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(nextScopeId: string | null, explicit = false) {
      if (explicit) {
        intentRevision += 1;
      }
      state.scopeId = nextScopeId;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

describe("watchAgentScope", () => {
  it("suppresses the initial scope and duplicate publications", () => {
    const current = selection("main");
    const onChange = vi.fn();
    const watch = watchAgentScope(onChange);
    const cleanup = watch(current.source);

    current.publish("main");
    current.publish("writer");

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("writer", false);
    cleanup();
  });

  it("keeps the observed scope across source replacement", () => {
    const first = selection("main");
    const replacement = selection("writer");
    const onChange = vi.fn();
    const watch = watchAgentScope(onChange);
    watch(first.source)();

    watch(replacement.source)();

    expect(onChange).toHaveBeenCalledWith("writer", true);
  });

  it("distinguishes explicit scope changes without carrying same-scope intent into hydration", () => {
    const current = selection("main");
    const onChange = vi.fn();
    const cleanup = watchAgentScope(onChange)(current.source);

    current.publish("main", true);
    current.publish("writer");
    current.publish("research", true);

    expect(onChange.mock.calls).toEqual([
      ["writer", false],
      ["research", true],
    ]);
    cleanup();
  });
});
