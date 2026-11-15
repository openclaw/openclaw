import { expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { prepareGatewayOperatorSessionRun } from "./operator-session-run.js";

it("follows newly installed command sources while refusing an obsolete prepared source", async () => {
  let current: {
    abortSignal?: AbortSignal;
    assertSourceCurrent?: () => void;
  } = { assertSourceCurrent() {} };
  const run = prepareGatewayOperatorSessionRun({
    authority: createAdmittedRunOperatorAuthority({
      profileId: "synthetic-operator",
      scopes: ["operator.write"],
      assertCurrent() {},
    }),
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:command-source",
    currentSource: () => current,
  });
  const prepared = await prepareSessionSourceAuthority(run.assertCurrent);
  try {
    const revoked = new Error("completion source closed");
    current = {
      assertSourceCurrent() {
        throw revoked;
      },
    };
    expect(() => run.assertCurrent()).toThrow(revoked);
    expect(() => prepared.assertCurrent()).toThrow(
      expect.objectContaining({ code: "SESSION_WORK_START_CHANGED" }),
    );

    const abort = new AbortController();
    const cancelled = new Error("command cancelled");
    current = { ...current, abortSignal: abort.signal };
    abort.abort(cancelled);
    expect(() => run.assertCurrent()).toThrow(cancelled);
    expect(() => prepared.assertCurrent()).toThrow(cancelled);
  } finally {
    await prepared.release?.();
  }
});
