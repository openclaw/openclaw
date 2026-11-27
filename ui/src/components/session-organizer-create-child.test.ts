import { describe, expect, it, vi } from "vitest";
import { createHarness, sessionRow } from "./session-organizer-batch-mutations.test-support.ts";
import { createNestedSession, isCreatingNestedSession } from "./session-organizer-menu.runtime.ts";
import { createChildSession } from "./session-organizer-operations.runtime.ts";
import { SessionOrganizer } from "./session-organizer.ts";

describe("persistent child-session creation", () => {
  it("deduplicates within a Gateway but does not lock the same parent key on another Gateway", async () => {
    const first = createHarness({ methods: ["sessions.create"] });
    const second = createHarness({ methods: ["sessions.create"] });
    const result = Promise.withResolvers<string | null>();
    first.create.mockReturnValueOnce(result.promise);
    let activeScope = first.scope;
    const organizer = new SessionOrganizer(
      {
        ...first.host,
        sessionData: {
          ...first.host.sessionData,
          beginSessionMutation: () => activeScope,
          isSessionMutationScopeCurrent: (scope) => scope === activeScope,
        },
      },
      vi.fn(),
    );
    const parent = sessionRow(1);
    const pending = createNestedSession(organizer, parent);
    await expect.poll(() => first.create.mock.calls.length).toBe(1);
    expect(isCreatingNestedSession(organizer, activeScope.client, parent.key)).toBe(true);
    await createNestedSession(organizer, parent);
    expect(first.create).toHaveBeenCalledTimes(1);
    activeScope = second.scope;
    expect(isCreatingNestedSession(organizer, activeScope.client, parent.key)).toBe(false);
    await createNestedSession(organizer, parent);
    expect(second.create).toHaveBeenCalledTimes(1);
    result.resolve("agent:main:first-child");
    await pending;
    expect(isCreatingNestedSession(organizer, activeScope.client, parent.key)).toBe(false);
    expect(first.selectSession).not.toHaveBeenCalledWith("agent:main:first-child");
  });

  it.each([false, true])(
    "creates a child with fork=%s without changing the parent",
    async (fork) => {
      const h = createHarness({ methods: ["sessions.create"] });
      const parent = sessionRow(1, { hasActiveRun: true });
      expect(await createChildSession(h.host, parent, h.scope, { fork })).toBe("completed");
      expect(h.create).toHaveBeenCalledWith(
        {
          parentSessionKey: parent.key,
          agentId: "main",
          ...(fork ? { fork: true, forkFrom: "last-completed" } : {}),
        },
        { signal: h.scope.signal },
      );
      expect(h.selectSession).toHaveBeenCalledWith("agent:main:nested-child");
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it("refuses child creation without parent write access", async () => {
    const h = createHarness({ methods: ["sessions.create"], scopes: ["operator.read"] });
    expect(await createChildSession(h.host, sessionRow(1), h.scope, { fork: false })).toBe(
      "failed",
    );
    expect(h.create).not.toHaveBeenCalled();
    expect(h.selectSession).not.toHaveBeenCalled();
    expect(h.publishSessionMutationError).toHaveBeenCalled();
  });

  it("does not navigate after the owning connection retires during creation", async () => {
    const h = createHarness({ methods: ["sessions.create"] });
    h.create.mockImplementationOnce(async () => {
      h.retireScope();
      return "agent:main:nested-child";
    });
    expect(await createChildSession(h.host, sessionRow(1), h.scope, { fork: false })).toBe("stale");
    expect(h.selectSession).not.toHaveBeenCalled();
  });

  it("publishes a create failure without navigating", async () => {
    const h = createHarness({ methods: ["sessions.create"] });
    h.create.mockRejectedValueOnce(new Error("Parent is no longer available"));
    expect(await createChildSession(h.host, sessionRow(1), h.scope, { fork: false })).toBe(
      "failed",
    );
    expect(h.publishSessionMutationError).toHaveBeenCalledWith(
      h.scope,
      expect.objectContaining({ message: "Parent is no longer available" }),
    );
    expect(h.selectSession).not.toHaveBeenCalled();
  });
});
