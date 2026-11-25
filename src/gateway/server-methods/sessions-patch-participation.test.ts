import { expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isParticipationPermissionTightening } from "./sessions-patch-participation.js";

it("compares fresh effective exec policy and never clears or widens the saved ceiling", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { sandbox: { mode: "off" } } },
    };
    const entry = (mode?: SessionEntry["permissionMode"]): SessionEntry => ({
      sessionId: "current",
      updatedAt: 1,
      ...(mode ? { permissionMode: mode } : {}),
    });
    for (const [before, after, expected] of [
      ["workspace", "guarded", true],
      ["guarded", "workspace", false],
      ["guarded", "read-only", true],
      ["read-only", "guarded", false],
      ["workspace", "full", false],
      ["workspace", undefined, false],
      ["guarded", "guarded", true],
    ] as const) {
      expect(
        await isParticipationPermissionTightening({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:patch",
          before: entry(before),
          after: entry(after),
        }),
        `${before}->${after}`,
      ).toBe(expected);
    }
    expect(
      await isParticipationPermissionTightening({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:patch",
        before: undefined,
        after: entry("guarded"),
      }),
    ).toBe(false);
    // No saved mode is not consent to widen an inherited deny/on-miss policy.
    cfg.tools = { exec: { security: "deny", ask: "off" } };
    expect(
      await isParticipationPermissionTightening({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:patch",
        before: entry(),
        after: entry("guarded"),
      }),
    ).toBe(false);
    expect(
      await isParticipationPermissionTightening({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:patch",
        before: entry(),
        after: entry("read-only"),
      }),
    ).toBe(true);
  });
});
