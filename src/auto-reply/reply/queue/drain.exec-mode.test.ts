import { describe, expect, it } from "vitest";
import { resolveFollowupAuthorizationKey } from "./drain.js";
import type { FollowupRun } from "./types.js";

function buildRun(
  execOverrides: NonNullable<FollowupRun["run"]["execOverrides"]>,
): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    message: "run a command",
    provider: "anthropic",
    model: "test-model",
    execOverrides,
  } as FollowupRun["run"];
}

describe("resolveFollowupAuthorizationKey exec mode", () => {
  it("splits collect batches when only exec mode differs (#112376)", () => {
    const autoKey = resolveFollowupAuthorizationKey(
      buildRun({
        host: "gateway",
        mode: "auto",
        security: "allowlist",
        ask: "on-miss",
      }),
    );
    const askKey = resolveFollowupAuthorizationKey(
      buildRun({
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(autoKey).not.toEqual(askKey);
  });
});
