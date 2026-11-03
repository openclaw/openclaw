import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
  sessionIsolationProfileId,
} from "../config/sessions/session-entry-provenance.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareSessionCreateParent,
  resolveSessionCreateInheritance,
} from "./session-create-inheritance.js";

it("keeps autonomous spawn creator separate from the inherited human sandbox", () => {
  const { creation } = resolveSessionCreateInheritance({
    request: {
      cfg: {},
      creation: { via: "spawn", actor: { type: "agent", id: "main" } },
    },
    parent: {
      target: { agentId: "main", canonicalKey: "agent:main:parent" },
      entry: {
        sessionId: "sandboxed-parent",
        updatedAt: 1,
        sandbox: "required",
        createdActor: { type: "human", source: "profile", id: "historical-human" },
      },
    },
  });
  expect(creation?.sandbox).toBe("required");
  expect(sessionIsolationProfileId(creation?.actor)).toBe("historical-human");
  expect(sessionCreatorProfileId(creation?.actor)).toBeUndefined();
  expect(resolveSessionCreatorActor(creation?.actor)).toEqual({ type: "agent", id: "main" });
});

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
