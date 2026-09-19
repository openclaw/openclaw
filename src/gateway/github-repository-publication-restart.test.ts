import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
  restartPersonalPublicationFixture,
} from "./github-personal-publication.test-support.js";
import {
  SESSION_ID,
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { readRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import {
  createRepositoryPublicationFixture,
  repositoryPublicationTestUrl as url,
} from "./github-repository-publication.test-support.js";
// Prepare the real reset entry point before timing its lifecycle operation.
import "./session-reset-service.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const repositoryFixture = () => createRepositoryPublicationFixture(checkpoint);

describe("repository checkpoint GitHub publication", () => {
  installGitHubPublicationTestHarness();
  afterEach(() => vi.unstubAllGlobals());
  it("fences publication reservations when the Gateway owner restarts", async () => {
    await repositoryFixture();
    const person = await createPersonalPublicationFixture();
    const previous = person.placements;
    await expect(
      previous.withWorkspaceExclusion(SESSION_ID, async (assertOwned) => {
        restartPersonalPublicationFixture(person);
        expect(assertOwned).toThrow("was aborted");
      }),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    await expect(previous.withWorkspaceExclusion(SESSION_ID, async () => {})).rejects.toMatchObject(
      { code: "OPENCLAW_STATE_LEASE_ABORTED" },
    );
    await person.placements.withWorkspaceExclusion(SESSION_ID, async (assertOwned) =>
      assertOwned(),
    );
  });

  it.each(["turn", "reset", "move", "held", "store-busy", "retired-owner"] as const)(
    "requires the same personal owner after restart and a later %s",
    async (boundary) => {
      const f = await repositoryFixture();
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
      const firstReply = await callPersonalPublicationRpc(
        person,
        "sessions.github.publish",
        request,
      );
      expect(firstReply[0], JSON.stringify(firstReply[2])).toBe(true);
      const first = firstReply[1];
      expect(first.status).toBe("needs_confirmation");
      const original = readRepositoryGitHubPublication(first.requestId)!;
      expect(original.pushed_head_commit).toBeNull();
      await f.capture("later unselected change\n", "later");
      const retiredCoordinator = person.coordinator;
      restartPersonalPublicationFixture(person);
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
      const database = openOpenClawStateDatabase();
      const holder = { owner: "previous-publication-owner", epoch: Date.now() };
      let writer: DatabaseSync | undefined;
      if (boundary === "held") {
        database.db
          .prepare(
            "INSERT INTO state_leases (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
          )
          .run(
            "session-workspace-action",
            SESSION_ID,
            holder.owner,
            holder.epoch + 60000,
            holder.epoch,
            holder.epoch,
            holder.epoch,
          );
      } else if (boundary === "store-busy") {
        expect(
          database.db
            .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
            .all("session-workspace-action", SESSION_ID),
        ).toEqual([]);
        writer = new DatabaseSync(database.path);
        writer.exec("BEGIN IMMEDIATE");
      }
      const confirmation = {
        sessionKey: SESSION_KEY,
        requestId: first.requestId,
        generation: person.generation,
        account: personalPublicationAccount,
        requestDigest: pending.confirmation!.requestDigest,
      };
      if (boundary === "retired-owner") {
        const aborted = await callPersonalPublicationRpc(
          { ...person, coordinator: retiredCoordinator },
          "sessions.github.confirm",
          confirmation,
        );
        expect(aborted[0]).toBe(false);
        expect(aborted[2]).toMatchObject({
          code: "UNAVAILABLE",
          retryable: false,
          details: {
            leaseAcquisition: {
              kind: "aborted",
              reason: "caller-signal",
              elapsedMs: expect.any(Number),
            },
          },
        });
        expect(aborted[2].details.leaseAcquisition.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(f.runtime.effects).toEqual(["push"]);
        expect(readRepositoryGitHubPublication(first.requestId)?.checkpoint_ref).toBe(
          original.checkpoint_ref,
        );
      }
      const confirmed = await callPersonalPublicationRpc(
        person,
        "sessions.github.confirm",
        confirmation,
      ).finally(() => {
        writer?.exec("ROLLBACK");
        writer?.close();
      });
      if (boundary === "held" || boundary === "store-busy") {
        expect(confirmed[0]).toBe(false);
        expect(confirmed[2]).toMatchObject(
          boundary === "held"
            ? {
                code: "FORBIDDEN",
                retryable: false,
                message: expect.stringContaining(`${holder.owner} (lease epoch ${holder.epoch})`),
                details: { leaseAcquisition: { kind: "held", holder } },
              }
            : {
                code: "UNAVAILABLE",
                retryable: true,
                details: { leaseAcquisition: { kind: "store-unavailable", reason: "sqlite-busy" } },
              },
        );
        expect(f.runtime.effects).toEqual(["push"]);
        return;
      }
      if (boundary === "reset") {
        expect(confirmed[0]).toBe(false);
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
