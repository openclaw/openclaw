import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareSessionCreateParent,
  resolveSessionCreateInheritance,
} from "./session-create-inheritance.js";

it("inherits an in-process parent update after warming discovery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const sessionKey = "agent:main:parent";
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId: "parent-session",
      updatedAt: 1,
      label: "before",
    });
    const input = { params: { cfg: {} }, key: sessionKey };
    const before = await prepareSessionCreateParent(input);
    expect(before).toMatchObject({ ok: true, entry: { label: "before" } });

    await patchSessionEntryCore(scope, () => ({ label: "after" }));

    const after = await prepareSessionCreateParent(input);
    expect(after).toMatchObject({
      ok: true,
      canonicalKey: sessionKey,
      entry: { sessionId: "parent-session", label: "after" },
    });
  });
});

it.each([undefined, false, true])(
  "uses the %s creator Lab without changing required isolation or ownership",
  (enabled) => {
    const parentActor = { type: "human", source: "profile", id: "parent" } as const;
    const isolationActor = { type: "human", source: "profile", id: "isolation" } as const;
    const caller = { type: "agent", id: "main" } as const;
    for (const sandbox of [undefined, "required"] as const) {
      const parent = {
        sessionId: "parent-session",
        updatedAt: 1,
        createdActor: parentActor,
        sandbox,
        sandboxProvenance: { actor: isolationActor },
      };
      const creation = { via: "spawn" as const, actor: caller, requesterProfileId: "requester" };
      const result = resolveSessionCreateInheritance(
        {
          cfg: { agents: { defaults: { experimental: { delegatedCreatorAttribution: enabled } } } },
          creation,
        },
        parent,
      );
      expect(result.creation?.actor).toEqual(
        enabled
          ? { type: "human", source: "profile", id: "requester" }
          : sandbox
            ? parentActor
            : caller,
      );
      expect(result.creation?.sandbox).toBe(sandbox);
      expect(result.creation?.sandboxProvenance).toEqual({
        actor: sandbox ? isolationActor : caller,
      });
      expect(result.ownerAssignment?.actor).toEqual(caller);
      expect(parent.createdActor).toEqual(parentActor);
      expect(
        resolveSessionCreateInheritance(
          {
            cfg: {},
            creation: { via: "operator", actor: parentActor },
          },
          parent,
        ).creation?.actor,
      ).toEqual(parentActor);
    }
  },
);
