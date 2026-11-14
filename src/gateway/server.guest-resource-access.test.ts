import { randomUUID } from "node:crypto";
import { Agent, fetch } from "undici";
import { expect, it, vi } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import {
  holdStateRead,
  publicationRowDefaults,
} from "../state/github-publication-fixtures.test-support.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import {
  ensureGitHubPublicationStoreFixture,
  insertRepositoryGitHubPublicationFixture,
} from "./github-publication-store.test-support.js";
import { repositoryGitHubPublicationDigest } from "./github-repository-publication.kernel.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import * as transcript from "./session-transcript-readers.js";

it("rechecks invited membership before artifact bytes and GitHub receipt disclosure", async ({
  signal,
}) => {
  await withInvitedGuestGateway(signal, async ({ state, gateway, sender, invited, carol }) => {
    const { key } = await sender.request<{ key: string }>(
      "sessions.create",
      { agentId: "main", visibility: "shared" },
      { signal },
    );
    const scope = { agentId: "main", sessionKey: key };
    const sessionId = loadSessionEntry(scope)!.sessionId;
    const membership = (method: "add" | "remove") =>
      sender.request(`session.members.${method}`, { ...scope, identityId: carol.id }, { signal });
    const marker = "Private invited artifact";
    await persistSessionTranscriptTurn(
      { ...scope, sessionId },
      {
        cwd: state.workspaceDir,
        updateMode: "inline",
        messages: [
          {
            message: {
              role: "assistant",
              content: [
                {
                  type: "file",
                  title: "private-proof.txt",
                  mimeType: "text/plain",
                  data: Buffer.from(marker).toString("base64"),
                },
              ],
            },
          },
        ],
      },
    );
    const artifacts = () =>
      invited.request<ArtifactsListResult>("artifacts.list", scope, { signal });
    await expect(artifacts()).rejects.toThrow();
    await membership("add");
    const listed = await artifacts();
    expect(listed.artifacts).toHaveLength(1);
    const download = () =>
      invited.request<ArtifactsDownloadResult>(
        "artifacts.download",
        { ...scope, artifactId: listed.artifacts[0]!.id, transport: "http" },
        { signal },
      );
    const ticket = await download();
    expect(ticket.url).toBeDefined();
    // The isolated loopback fixture uses a static self-signed test certificate.
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    try {
      const bytes = () =>
        fetch(new URL(ticket.url!, `https://127.0.0.1:${gateway.port}`), { dispatcher, signal });
      const allowed = await bytes();
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe(marker);
      const entered = createDeferred();
      const release = createDeferred();
      const readArtifacts = transcript.readSessionArtifacts;
      let armed = true;
      using _ = vi
        .spyOn(transcript, "readSessionArtifacts")
        .mockImplementation(async (target, query) => {
          const result = await readArtifacts(target, query);
          if (armed && target.sessionKey === key && query.kind === "download-response") {
            armed = false;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const pending = bytes();
      void pending.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Artifact response skipped its real read",
          ),
          signal,
        );
        await membership("remove");
        release.resolve();
        const withheld = await pending;
        expect(withheld.status).toBe(404);
        expect(await withheld.text()).not.toContain(marker);
        const replay = await bytes();
        expect(replay.status).toBe(404);
        expect(await replay.text()).not.toContain(marker);
        await expect(download()).rejects.toThrow();
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    } finally {
      await dispatcher.destroy();
    }
    const requestId = randomUUID();
    const url = "https://github.com/example/repository/pull/42";
    const row: RepositoryGitHubPublicationRow = {
      ...publicationRowDefaults(requestId),
      session_key: key,
      session_id: sessionId,
      session_lifecycle_revision: null,
      requester_authority_json: null,
      workspace_id: "workspace-proof",
      owner_profile_id: null,
      connection_generation: null,
      identity_source: "system-configured",
      identity_profile_id: "fixture-profile",
      previous_head_commit: null,
      pushed_head_commit: null,
      claim_id: null,
      run_id: null,
      environment_id: null,
      owner_epoch: null,
      placement_generation: null,
      checkpoint_ref: null,
      checkpoint_digest: null,
      status: "published",
      head_commit: "b".repeat(40),
      pull_request_url: url,
    };
    row.request_digest = repositoryGitHubPublicationDigest(row);
    ensureGitHubPublicationStoreFixture();
    insertRepositoryGitHubPublicationFixture(row, () => {});
    const status = () =>
      invited.request("sessions.github.status", { ...scope, requestId }, { signal });
    await expect(status()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await membership("add");
    expect(JSON.stringify(await status())).toContain(url);
    const held = holdStateRead("githubPublications.sharedObservation");
    const pendingStatus = status();
    void pendingStatus.catch(() => {});
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          held.ready,
          pendingStatus,
          "GitHub status skipped the receipt read",
        ),
        signal,
      );
      await membership("remove");
      held.release();
      await expect(pendingStatus).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(status()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      held.release();
      await Promise.allSettled([pendingStatus]);
      held.restore();
    }
  });
});
