import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as backoff from "../infra/backoff.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
} from "./github-personal-publication.test-support.js";
import {
  SESSION_KEY,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { readRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import {
  createRepositoryPublicationFixture,
  repositoryPublicationTestUrl as url,
} from "./github-repository-publication.test-support.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

// Cold reset imports are fixture preparation, outside the publication behavior's test budget.
await import("./session-reset-service.js");

describe("repository checkpoint GitHub publication", () => {
  installGitHubPublicationTestHarness();
  afterEach(() => vi.unstubAllGlobals());

  it.each(["turn", "reset", "move", "maintenance write", "brief maintenance write"] as const)(
    "requires the same personal owner after restart and a later %s",
    async (boundary) => {
      const f = await createRepositoryPublicationFixture(checkpoint);
      const person = await createPersonalPublicationFixture();
      f.runtime.accountId = personalPublicationAccount.accountId;
      f.runtime.interruptPush = true;
      const request = {
        sessionKey: SESSION_KEY,
        idempotencyKey: "personal",
        selection: {
          source: "personal",
          generation: person.generation,
          account: personalPublicationAccount,
        },
      };
      const first = (
        await callPersonalPublicationRpc(person, "sessions.github.publish", request)
      )[1];
      expect(first.status).toBe("needs_confirmation");
      const original = readRepositoryGitHubPublication(first.requestId)!;
      expect(original.pushed_head_commit).toBeNull();
      await f.capture("later unselected change\n", "later");
      person.coordinator = createTestGitHubPublicationCoordinator({
        placements: person.placements,
      });
      const pending = person.coordinator.personalStatus(
        person.action,
        person.action,
        first.requestId,
      );
      expect(pending.confirmation?.workspaceTree).toBe(f.first.workspaceTree);
      expect(() =>
        person.coordinator.personalStatus(
          { ...person.action, owner: person.otherOwner },
          person.action,
          first.requestId,
        ),
      ).toThrow();
      if (boundary === "move") {
        await patchSessionEntryCore(
          {
            agentId: "main",
            sessionKey: SESSION_KEY,
            storePath: mocks.loadSession(SESSION_KEY).storePath,
          },
          (current) => ({
            ...current,
            repositoryWorkspaceId: undefined,
          }),
          { replaceEntry: true },
        );
        expect(mocks.loadSession(SESSION_KEY).entry.repositoryWorkspaceId).toBeUndefined();
        expect(
          person.coordinator.personalStatus(person.action, person.action, first.requestId),
        ).toMatchObject({
          result: { status: "failed", code: "session_changed" },
          confirmation: null,
        });
        return;
      }
      if (boundary === "reset") {
        await f.closeSession("reset");
        const status = await callPersonalPublicationRpc(person, "sessions.github.status", {
          sessionKey: SESSION_KEY,
          requestId: first.requestId,
        });
        expect(status[1]).toMatchObject({
          result: { status: "failed", code: "session_changed" },
          confirmation: null,
        });
      }
      const confirmation = {
        sessionKey: SESSION_KEY,
        requestId: first.requestId,
        generation: person.generation,
        account: personalPublicationAccount,
        requestDigest: pending.confirmation!.requestDigest,
      };
      if (boundary === "maintenance write" || boundary === "brief maintenance write") {
        const database = openOpenClawStateDatabase();
        const maintenance = new DatabaseSync(database.path);
        const started = performance.now();
        let elapsed = started;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        const wait = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (delayMs) => {
          elapsed += delayMs;
          if (boundary === "brief maintenance write" && maintenance.isTransaction) {
            maintenance.exec("ROLLBACK");
          }
        });
        try {
          // A separate connection models the maintenance worker's handle-lease registration.
          maintenance.exec("BEGIN IMMEDIATE");
          maintenance
            .prepare(
              `INSERT INTO agent_database_leases
                (lease_id, agent_id, path, owner_pid, owner_start_time, opened_at)
               VALUES (?, ?, ?, ?, NULL, ?)`,
            )
            .run("maintenance-writer", "main", "/fixture/agent.sqlite", process.pid, Date.now());
          expect(database.db.prepare("SELECT * FROM state_leases").all()).toEqual([]);
          const commandsBefore = mocks.runCommand.mock.calls.length;
          const blocked = await callPersonalPublicationRpc(
            person,
            "sessions.github.confirm",
            confirmation,
          );
          expect(wait).toHaveBeenCalled();
          expect(elapsed - started).toBeLessThanOrEqual(100);
          if (boundary === "brief maintenance write") {
            expect(blocked[0], JSON.stringify(blocked[2])).toBe(true);
            expect(blocked[1]).toMatchObject({ status: "published", url });
          } else {
            expect(blocked).toEqual([
              false,
              undefined,
              {
                code: "UNAVAILABLE",
                retryable: true,
                message: expect.stringContaining("shared-state database is busy"),
              },
            ]);
            expect(blocked[2].message).toContain("100 ms");
            expect(blocked[2].message).toContain("Retry after");
            expect(mocks.runCommand).toHaveBeenCalledTimes(commandsBefore);
            expect(readRepositoryGitHubPublication(first.requestId)).toEqual(original);
            expect(f.runtime.effects).toEqual(["push"]);
          }
        } finally {
          wait.mockRestore();
          clock.mockRestore();
          if (maintenance.isTransaction) {
            maintenance.exec("ROLLBACK");
          }
          maintenance.close();
        }
      }
      const confirmed = await callPersonalPublicationRpc(
        person,
        "sessions.github.confirm",
        confirmation,
      );
      if (boundary === "reset") {
        expect(confirmed[0]).toBe(false);
        expect(confirmed[2]).toMatchObject({ code: "FORBIDDEN" });
        expect(f.runtime.effects).toEqual(["push"]);
        return;
      }
      expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
      expect(confirmed[1]).toMatchObject({ status: "published", url });
      expect(readRepositoryGitHubPublication(first.requestId)?.checkpoint_ref).toBe(
        original.checkpoint_ref,
      );
      expect(readRepositoryGitHubPublication(first.requestId)?.pushed_head_commit).toBe(
        f.runtime.head,
      );
      expect(f.runtime.effects).toEqual(["push", "pull_request"]);
      expect(f.runtime.uploaded.size).toBe(1);
    },
  );
});
