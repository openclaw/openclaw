import { describe, expect, it } from "vitest";
import { NodeWorkerRepositoryReadiness } from "./node-worker-repository-readiness.js";

const identity = {
  environmentId: "fixture",
  sessionId: "session",
  sessionKey: "agent:main:fixture",
  generation: 3,
};
const repository = {
  workspaceId: "workspace",
  revision: 4,
  branch: "fixture/topic",
  baseCommit: "a".repeat(40),
};

describe("node repository preparation custody", () => {
  it("waits for the exact admitted head and rechecks authority after the wait", async () => {
    const owner = new NodeWorkerRepositoryReadiness();
    owner.begin(identity, repository);
    let current = true;
    const lease = owner.capture(identity, () => {
      if (!current) {
        throw new Error("authority revoked");
      }
    })!;
    let completed = false;
    const waiting = lease.wait(new AbortController().signal).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(() =>
      owner.settle(identity, { ...repository, baseCommit: "b".repeat(40) }, "ready"),
    ).toThrow("owner changed");
    {
      owner.settle(identity, repository, "ready");
    }
    current = false;
    await expect(waiting).rejects.toThrow("authority revoked");
  });

  it.each(["failed", "replacement", "cancelled", "closed"] as const)(
    "never admits a late operation after %s",
    async (outcome) => {
      const owner = new NodeWorkerRepositoryReadiness();
      owner.begin(identity, repository);
      const controller = new AbortController();
      const lease = owner.capture(identity, () => {})!;
      const waiting = lease.wait(controller.signal);
      void waiting.catch(() => undefined);
      if (outcome === "failed") {
        owner.settle(identity, repository, "failed");
      }
      if (outcome === "replacement") {
        owner.begin({ ...identity, generation: 4 }, repository);
      }
      if (outcome === "cancelled") {
        controller.abort();
      }
      if (outcome === "closed") {
        owner.close();
      }
      await expect(waiting).rejects.toThrow();
      if (outcome === "replacement") {
        expect(() => owner.settle(identity, repository, "ready")).toThrow("owner changed");
        expect(() => owner.begin(identity, repository)).toThrow("stale");
      }
      if (outcome === "cancelled") {
        owner.settle(identity, repository, "ready");
      }
      if (outcome !== "cancelled") {
        expect(() => lease.assertCurrent()).toThrow();
      }
    },
  );

  it("refuses foreign sessions and changed repository revisions in an owned epoch", () => {
    const owner = new NodeWorkerRepositoryReadiness();
    owner.begin(identity, repository);
    expect(() => owner.begin({ ...identity, sessionId: "foreign" }, repository)).toThrow("foreign");
    expect(() => owner.begin(identity, { ...repository, revision: 5 })).toThrow("replace");
    expect(() => owner.settle({ ...identity, sessionKey: "foreign" }, repository, "ready")).toThrow(
      "owner changed",
    );
  });
});
