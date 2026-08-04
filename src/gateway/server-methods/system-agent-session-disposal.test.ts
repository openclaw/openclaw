import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { WizardSession } from "../../wizard/session.js";
import {
  assertSystemAgentGatewayExecutionActive,
  runSystemAgentGatewayOwnerTask,
  runSystemAgentGatewayTask,
} from "./system-agent-execution-lifecycle.js";
import {
  disposeSystemAgentSessions,
  disposeSystemAgentSessionsForOwner,
} from "./system-agent-session-disposal.js";
import type { GatewayRequestContext } from "./types.js";
import { type SetupWizardRunner, wizardHandlers } from "./wizard.js";

type SystemAgentChatSession =
  GatewayRequestContext["systemAgentSessions"] extends Map<string, infer Session> ? Session : never;

function sessionWithDispose(
  dispose: () => Promise<void>,
  persistentApplySettlement: Promise<void> | null = null,
  ownerKey = "device:test",
): SystemAgentChatSession {
  return {
    ownerKey,
    engine: { dispose, getPersistentApplySettlement: () => persistentApplySettlement },
  } as unknown as SystemAgentChatSession;
}

async function waitForTaskAdmission(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("disposeSystemAgentSessions", () => {
  it("retires only sessions owned by a disconnected connection", async () => {
    const disposeConnection = vi.fn(async () => {});
    const disposeDevice = vi.fn(async () => {});
    const sessions = new Map<string, SystemAgentChatSession>([
      ["connection", sessionWithDispose(disposeConnection, null, "connection:conn-1")],
      ["device", sessionWithDispose(disposeDevice, null, "device:device-1")],
    ]);

    const disposal = disposeSystemAgentSessionsForOwner(sessions, "connection:conn-1");

    expect(Array.from(sessions.keys())).toEqual(["device"]);
    await expect(disposal).resolves.toBeUndefined();
    expect(disposeConnection).toHaveBeenCalledOnce();
    expect(disposeDevice).not.toHaveBeenCalled();
  });

  it("rejects an admitted first request before it can publish after disconnect", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const ownerKey = "connection:conn-first";
    const requestStarted = createDeferred();
    const releaseRequest = createDeferred();
    const admitted = runSystemAgentGatewayOwnerTask(ownerKey, sessions, async () => {
      requestStarted.resolve();
      await releaseRequest.promise;
      assertSystemAgentGatewayExecutionActive(sessions, ownerKey);
      sessions.set(
        "orphaned",
        sessionWithDispose(async () => {}, null, ownerKey),
      );
    });
    await requestStarted.promise;

    const disposal = disposeSystemAgentSessionsForOwner(sessions, ownerKey);
    releaseRequest.resolve();

    await expect(admitted).rejects.toThrow("connection owner has been retired");
    await expect(disposal).resolves.toBeUndefined();
    expect(sessions.size).toBe(0);
  });

  it("does not globally fence an ordinary slow turn from a disconnected owner", async () => {
    const releaseTurn = createDeferred();
    const sessions = new Map<string, SystemAgentChatSession>([
      [
        "slow",
        sessionWithDispose(
          async () => {
            await releaseTurn.promise;
          },
          null,
          "connection:conn-slow",
        ),
      ],
    ]);

    const disposal = disposeSystemAgentSessionsForOwner(sessions, "connection:conn-slow");
    const replacementTask = vi.fn(async () => "replacement");
    await expect(runSystemAgentGatewayTask(replacementTask, new Map())).resolves.toBe(
      "replacement",
    );
    expect(replacementTask).toHaveBeenCalledOnce();

    releaseTurn.resolve();
    await expect(disposal).resolves.toBeUndefined();
  });

  it("keeps a disconnected owner's persistent apply behind the global fence", async () => {
    const releaseApply = createDeferred();
    const sessions = new Map<string, SystemAgentChatSession>([
      [
        "applying",
        sessionWithDispose(async () => {}, releaseApply.promise, "connection:conn-applying"),
      ],
    ]);

    await disposeSystemAgentSessionsForOwner(sessions, "connection:conn-applying");
    const replacementTask = vi.fn(async () => "replacement");
    const replacement = runSystemAgentGatewayTask(replacementTask, new Map());
    await waitForTaskAdmission();
    expect(replacementTask).not.toHaveBeenCalled();

    releaseApply.resolve();
    await expect(replacement).resolves.toBe("replacement");
  });

  it("clears and disposes every session before surfacing failures", async () => {
    const releaseFirst = createDeferred();
    const disposeFirst = vi.fn(async () => {
      expect(sessions.size).toBe(0);
      await releaseFirst.promise;
    });
    const disposeSecond = vi.fn(async () => {
      throw new Error("second disposal failed");
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["first", sessionWithDispose(disposeFirst)],
      ["second", sessionWithDispose(disposeSecond)],
    ]);
    const wizard = new WizardSession(async (prompter) => {
      await prompter.confirm({ message: "Continue?" });
    });
    await wizard.next();
    const wizardSessions = new Map([["waiting", wizard]]);

    const disposal = disposeSystemAgentSessions(sessions, wizardSessions);

    expect(sessions.size).toBe(0);
    expect(wizardSessions.size).toBe(0);
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeSecond).toHaveBeenCalledOnce();
    releaseFirst.resolve();
    await expect(disposal).rejects.toMatchObject({
      name: "AggregateError",
      message: "Failed to dispose system-agent sessions",
      errors: [expect.objectContaining({ message: "second disposal failed" })],
    });
    expect(wizard.getStatus()).toBe("cancelled");
  });

  it("rejects a wizard start admitted after shutdown retirement", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const wizardSessions = new Map();
    const wizardRunner = vi.fn<SetupWizardRunner>(async () => undefined);
    const disposal = disposeSystemAgentSessions(sessions, wizardSessions);
    const start = wizardHandlers["wizard.start"];
    if (!start) {
      throw new Error("wizard.start test invariant");
    }

    await expect(
      start({
        params: { mode: "local" },
        respond: vi.fn(),
        context: {
          systemAgentSessions: sessions,
          wizardSessions,
          wizardRunner,
          findRunningWizard: () => undefined,
          purgeWizardSession: (sessionId: string) => wizardSessions.delete(sessionId),
        },
      } as never),
    ).rejects.toThrow("Gateway generation has been retired");

    await expect(disposal).resolves.toBeUndefined();
    expect(wizardRunner).not.toHaveBeenCalled();
    expect(wizardSessions.size).toBe(0);
  });

  it("holds replacement work until a commit-locked wizard settles", async () => {
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const wizard = new WizardSession(async (_prompter, _signal, session) => {
      session.lockCancellation();
      mutationStarted.resolve();
      await releaseMutation.promise;
    });
    await mutationStarted.promise;
    const wizardSessions = new Map([["locked", wizard]]);

    const disposal = disposeSystemAgentSessions(new Map(), wizardSessions);
    expect(wizardSessions.size).toBe(0);
    const replacementTask = vi.fn(async () => "replacement");
    const replacement = runSystemAgentGatewayTask(replacementTask, new Map());
    await waitForTaskAdmission();
    expect(replacementTask).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await expect(disposal).resolves.toBeUndefined();
    await expect(replacement).resolves.toBe("replacement");
  });

  it("holds replacement work until an engine commit settles", async () => {
    const releaseMutation = createDeferred();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["mutating", sessionWithDispose(async () => {}, releaseMutation.promise)],
    ]);

    const disposal = disposeSystemAgentSessions(sessions, new Map());
    const replacementTask = vi.fn(async () => "replacement");
    const replacement = runSystemAgentGatewayTask(replacementTask, new Map());
    await waitForTaskAdmission();
    expect(replacementTask).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await expect(disposal).resolves.toBeUndefined();
    await expect(replacement).resolves.toBe("replacement");
  });

  it("reports a failed engine commit without poisoning replacement work", async () => {
    const sessions = new Map<string, SystemAgentChatSession>([
      [
        "mutating",
        sessionWithDispose(async () => {}, Promise.reject(new Error("engine commit failed"))),
      ],
    ]);

    await expect(disposeSystemAgentSessions(sessions, new Map())).rejects.toMatchObject({
      name: "AggregateError",
      message: "Failed to dispose system-agent sessions",
      errors: [expect.objectContaining({ message: "engine commit failed" })],
    });

    const replacementTask = vi.fn(async () => "replacement");
    await expect(runSystemAgentGatewayTask(replacementTask, new Map())).resolves.toBe(
      "replacement",
    );
    expect(replacementTask).toHaveBeenCalledOnce();
  });

  it("rejects replacement work within a bounded wait when an engine commit stalls", async () => {
    vi.useFakeTimers();
    const releaseMutation = createDeferred();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["mutating", sessionWithDispose(async () => {}, releaseMutation.promise)],
    ]);
    const disposal = disposeSystemAgentSessions(sessions, new Map());
    const replacementTask = vi.fn(async () => "replacement");

    try {
      const replacement = runSystemAgentGatewayTask(replacementTask, new Map());
      const rejection = expect(replacement).rejects.toThrow("try again shortly");
      await vi.runOnlyPendingTimersAsync();

      await rejection;
      expect(replacementTask).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await disposal;
      vi.useRealTimers();
    }

    await expect(runSystemAgentGatewayTask(replacementTask, new Map())).resolves.toBe(
      "replacement",
    );
  });
});
