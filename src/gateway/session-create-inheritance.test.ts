import { expect, it } from "vitest";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionCreateParent } from "./session-create-inheritance.js";

it("inherits an in-process parent update after warming discovery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
