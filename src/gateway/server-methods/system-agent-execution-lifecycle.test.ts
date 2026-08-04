import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import {
  runSystemAgentGatewayMutationTask,
  runSystemAgentGatewayTask,
} from "./system-agent-execution-lifecycle.js";
import { disposeSystemAgentSessions } from "./system-agent-session-disposal.js";
import type { GatewayRequestContext } from "./types.js";

async function waitForTaskAdmission(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("system-agent Gateway execution lifecycle", () => {
  it("rejects a queued callback after its Gateway generation is disposed", async () => {
    const sessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const queuedTask = vi.fn(async () => "stale");
    const first = runSystemAgentGatewayTask(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return "current";
    }, sessions);
    await firstStarted.promise;
    const queued = runSystemAgentGatewayTask(queuedTask, sessions);

    await disposeSystemAgentSessions(sessions, new Map());
    releaseFirst.resolve();

    await expect(first).resolves.toBe("current");
    await expect(queued).rejects.toThrow("Gateway generation has been retired");
    expect(queuedTask).not.toHaveBeenCalled();
  });

  it("does not block a replacement Gateway behind stale work", async () => {
    const staleSessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const replacementSessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const staleStarted = createDeferred();
    const releaseStale = createDeferred();
    const stale = runSystemAgentGatewayTask(async () => {
      staleStarted.resolve();
      await releaseStale.promise;
      return "stale";
    }, staleSessions);
    await staleStarted.promise;

    await disposeSystemAgentSessions(staleSessions, new Map());
    const replacementTask = vi.fn(async () => "replacement");
    await expect(runSystemAgentGatewayTask(replacementTask, replacementSessions)).resolves.toBe(
      "replacement",
    );
    expect(replacementTask).toHaveBeenCalledOnce();

    releaseStale.resolve();
    await expect(stale).resolves.toBe("stale");
  });

  it("holds replacement work until a retired direct mutation settles", async () => {
    const staleSessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const replacementSessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runSystemAgentGatewayMutationTask(async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
      return "mutated";
    }, staleSessions);
    await mutationStarted.promise;

    const disposal = disposeSystemAgentSessions(staleSessions, new Map());
    const replacementTask = vi.fn(async () => "replacement");
    const replacement = runSystemAgentGatewayTask(replacementTask, replacementSessions);
    await waitForTaskAdmission();
    expect(replacementTask).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await expect(mutation).resolves.toBe("mutated");
    await expect(disposal).resolves.toBeUndefined();
    await expect(replacement).resolves.toBe("replacement");
  });

  it("releases replacement work after a queued retired mutation is rejected", async () => {
    const staleSessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const replacementSessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const staleStarted = createDeferred();
    const releaseStale = createDeferred();
    const stale = runSystemAgentGatewayTask(async () => {
      staleStarted.resolve();
      await releaseStale.promise;
      return "stale";
    }, staleSessions);
    await staleStarted.promise;

    const mutationTask = vi.fn(async () => "mutated");
    const mutation = runSystemAgentGatewayMutationTask(mutationTask, staleSessions);
    const disposal = disposeSystemAgentSessions(staleSessions, new Map());
    await expect(mutation).rejects.toThrow("Gateway generation has been retired");
    expect(mutationTask).not.toHaveBeenCalled();

    const replacementTask = vi.fn(async () => "replacement");
    await expect(runSystemAgentGatewayTask(replacementTask, replacementSessions)).resolves.toBe(
      "replacement",
    );
    expect(replacementTask).toHaveBeenCalledOnce();

    releaseStale.resolve();
    await expect(stale).resolves.toBe("stale");
    await expect(disposal).resolves.toBeUndefined();
  });
});
