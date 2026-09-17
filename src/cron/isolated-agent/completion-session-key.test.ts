import { describe, expect, it } from "vitest";
import { isDetachedCronSessionTarget } from "../session-target.js";
import {
  resolveCronExecCompletionSession,
  resolveCronExecCompletionSessionKey,
} from "./completion-session-key.js";

describe("resolveCronExecCompletionSessionKey", () => {
  it("does not isolate normal main-session completions", () => {
    expect(
      resolveCronExecCompletionSessionKey({
        usesDetachedRunSession: isDetachedCronSessionTarget("main"),
        runSessionKey: "agent:main:main",
        completionSessionKey: "agent:main:telegram:group:-1001:topic:47",
      }),
    ).toBeUndefined();
  });

  it("does not isolate when the completion and run sessions are identical", () => {
    expect(
      resolveCronExecCompletionSessionKey({
        usesDetachedRunSession: true,
        runSessionKey: "agent:main:main",
        completionSessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });

  it("isolates a detached completion owned by a distinct source session", () => {
    expect(
      resolveCronExecCompletionSessionKey({
        usesDetachedRunSession: true,
        runSessionKey: "agent:main:cron:topic-cron:run:test-run-id",
        completionSessionKey: "agent:main:telegram:group:-1001:topic:47",
      }),
    ).toBe("agent:main:telegram:group:-1001:topic:47");
  });

  it("captures only an existing saved completion session generation", () => {
    const params = {
      usesDetachedRunSession: true,
      runSessionKey: "agent:main:cron:topic-cron",
      completionSessionKey: "agent:main:telegram:group:-1001:topic:47",
    };
    expect(resolveCronExecCompletionSession({ ...params, sessionStore: {} })).toEqual({});
    expect(
      resolveCronExecCompletionSession({
        ...params,
        sessionStore: {
          [params.completionSessionKey]: {
            sessionId: "source-session",
            lifecycleRevision: "source-revision",
          },
        },
      }),
    ).toEqual({
      sessionKey: params.completionSessionKey,
      generation: {
        sessionId: "source-session",
        lifecycleRevision: "source-revision",
      },
    });
  });
});
