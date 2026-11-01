import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry-replace.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import {
  resolveLocalWorkspaceOwner,
  reuseLocalWorkspaceProjection,
} from "../worker-environments/local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "../worker-environments/local-workspace-store.test-support.js";
import { expectCutReply } from "./sessions-rewind.handler.test-support.js";
import { withMessageCutLocalWorkspace } from "./sessions-rewind.local-workspace.test-support.js";
import {
  cfg,
  invokeMessageCut,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();

type WorkspaceFixture = Parameters<Parameters<typeof withMessageCutLocalWorkspace>[0]>[0];

async function persistCut(fixture: WorkspaceFixture) {
  const cut = invokeMessageCut("sessions.rewind", fixture.scope);
  expect(await cut.error).toBeUndefined();
  expectCutReply(cut.respond, { editorText: "What did I say?" });
  const entry = expectDefined(
    await readSessionEntryReadOnlyInWorker(fixture.scope),
    "persisted cut successor",
  );
  const receipt = expectDefined(entry.localWorkspaceHandoff, "persisted cut handoff");
  const row = expectDefined(
    await readLocalWorkspaceProjection(fixture.worktree.id),
    "settled predecessor projection",
  );
  expect(receipt).toMatchObject({
    fromSessionId: fixture.scope.sessionId,
    toSessionId: entry.sessionId,
    worktreeId: fixture.worktree.id,
    projectionRevision: row.revision,
  });
  expect(row.session_id).toBe(fixture.scope.sessionId);
  expect(await fs.readFile(path.join(fixture.canonical, "source.txt"), "utf8")).toBe(
    "stopped turn edit\n",
  );
  return { entry, receipt, row };
}

async function expectAdoption(
  fixture: WorkspaceFixture,
  saved: Awaited<ReturnType<typeof persistCut>>,
) {
  using resumed = expectDefined(
    await resolveLocalWorkspaceOwner({ cfg, ...fixture.scope }),
    "authorized successor owner",
  );
  expect(resumed.sessionId).toBe(saved.entry.sessionId);
  expect(await readLocalWorkspaceProjection(fixture.worktree.id)).toEqual({
    ...saved.row,
    session_id: saved.entry.sessionId,
    revision: saved.row.revision + 1,
  });
  expect(
    (await readSessionEntryReadOnlyInWorker(fixture.scope))?.localWorkspaceHandoff,
  ).toBeUndefined();
  expect(await reuseLocalWorkspaceProjection(resumed)).toBe(fixture.projection);
  expect(await fs.readFile(path.join(fixture.projection, "source.txt"), "utf8")).toBe(
    "stopped turn edit\n",
  );
  expect(await fs.readFile(path.join(fixture.projection, "ignored.txt"), "utf8")).toBe(
    "guest-only ignored data\n",
  );
}

it("refuses persisted foreign handoffs before transferring the row", async () => {
  await withMessageCutLocalWorkspace(async (fixture) => {
    const saved = await persistCut(fixture);
    for (const foreign of [
      "fromSessionId",
      "toSessionId",
      "lifecycleRevision",
      "worktreeId",
      "successor incarnation",
    ] as const) {
      // Corrupt only through the entry owner: the receipt starts with an actual handler commit.
      await patchSessionEntryCore(fixture.scope, () =>
        foreign === "successor incarnation"
          ? { sessionId: randomUUID() }
          : { localWorkspaceHandoff: { ...saved.receipt, [foreign]: randomUUID() } },
      );
      // Discard in-process facts so the attempted adoption consumes the persisted receipt.
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      let transfers = 0;
      const command = probe.command(stateWorker, (request, options, worker) => {
        if (request.type === "localWorkspace.mutate") {
          transfers++;
        }
        return worker.execute(request, options);
      });
      await expect(resolveLocalWorkspaceOwner({ cfg, ...fixture.scope })).rejects.toThrow(
        "different session incarnation",
      );
      command.mockRestore();
      expect(transfers).toBe(0);
      expect(await readLocalWorkspaceProjection(fixture.worktree.id)).toEqual(saved.row);
      expect(
        (await readSessionEntryReadOnlyInWorker(fixture.scope))?.localWorkspaceHandoff,
      ).toBeDefined();
      await patchSessionEntryCore(fixture.scope, () => ({
        sessionId: saved.entry.sessionId,
        localWorkspaceHandoff: saved.receipt,
      }));
    }
    await expectAdoption(fixture, saved);
  });
});

it.each(["caller revoked at commit", "successor reassigned at commit"] as const)(
  "refuses adoption and persisted receipt replay when %s",
  async (revocation) => {
    await withMessageCutLocalWorkspace(async (fixture) => {
      const saved = await persistCut(fixture);
      let current = true;
      // Admit the native session owner before the independent workspace transaction.
      // Opening it inside a grant would need shared-state registration under that lock.
      if (revocation === "successor reassigned at commit") {
        openOpenClawAgentDatabase({ agentId: fixture.scope.agentId });
      }
      let transfers = 0;
      let commits = 0;
      let adopting = false;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("successor caller revoked");
        }
      };
      const admission = probe.admission(workerAdmission, (request, grant, callback) => {
        if (
          adopting &&
          request.stage === "commit" &&
          isRecord(request.facts) &&
          request.facts.kind === "state-leases"
        ) {
          commits++;
          if (revocation === "caller revoked at commit") {
            current = false;
          } else {
            // The native entry owner publishes real successor reassignment before
            // granting the independent workspace database's adoption COMMIT.
            replaceSessionEntrySync(fixture.scope, { ...saved.entry, sessionId: randomUUID() });
          }
        }
        callback(request, grant);
      });
      const command = probe.command(stateWorker, async (request, options, worker) => {
        if (request.type !== "localWorkspace.mutate") {
          return worker.execute(request, options);
        }
        transfers++;
        adopting = true;
        try {
          return await worker.execute(request, options);
        } finally {
          adopting = false;
        }
      });
      try {
        await expect(
          resolveLocalWorkspaceOwner({ cfg, ...fixture.scope, assertCurrent }),
        ).rejects.toThrow(
          revocation === "caller revoked at commit"
            ? "successor caller revoked"
            : "authority changed",
        );
      } finally {
        command.mockRestore();
        admission.mockRestore();
      }
      expect(transfers).toBe(1);
      expect(commits).toBe(1);
      expect(await readLocalWorkspaceProjection(fixture.worktree.id)).toEqual(saved.row);
      expect(
        (await readSessionEntryReadOnlyInWorker(fixture.scope))?.localWorkspaceHandoff,
      ).toEqual(saved.receipt);
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      await expect(
        resolveLocalWorkspaceOwner({ cfg, ...fixture.scope, assertCurrent }),
      ).rejects.toThrow(
        revocation === "caller revoked at commit"
          ? "successor caller revoked"
          : "different session incarnation",
      );
      expect(await readLocalWorkspaceProjection(fixture.worktree.id)).toEqual(saved.row);
      current = true;
      await patchSessionEntryCore(fixture.scope, () => ({ sessionId: saved.entry.sessionId }));
      await expectAdoption(fixture, saved);
    });
  },
);

it("keeps persisted sessions without a handoff usable after settings and ordinary edits", async () => {
  await withMessageCutLocalWorkspace(async (fixture) => {
    expect(
      (await readSessionEntryReadOnlyInWorker(fixture.scope))?.localWorkspaceHandoff,
    ).toBeUndefined();
    await patchSessionEntryCore(fixture.scope, () => ({ label: "Renamed", thinkingLevel: "high" }));
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    using owner = expectDefined(
      await resolveLocalWorkspaceOwner({ cfg, ...fixture.scope }),
      "existing owner without a handoff",
    );
    expect(owner.sessionId).toBe(fixture.scope.sessionId);
    expect(await reuseLocalWorkspaceProjection(owner)).toBe(fixture.projection);
    expect((await readLocalWorkspaceProjection(fixture.worktree.id))?.session_id).toBe(
      fixture.scope.sessionId,
    );
    expect(await readSessionEntryReadOnlyInWorker(fixture.scope)).toMatchObject({
      label: "Renamed",
      thinkingLevel: "high",
    });
    expect(await fs.readFile(path.join(fixture.projection, "source.txt"), "utf8")).toBe(
      "stopped turn edit\n",
    );
    expect(await fs.readFile(path.join(fixture.canonical, "source.txt"), "utf8")).toBe(
      "stopped turn edit\n",
    );
  });
});
