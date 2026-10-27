import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import { initializeRepository } from "./server-methods/projects.test-support.js";
import * as sharing from "./session-sharing-preparation.js";
import * as placement from "./worker-environments/session-placement-lifecycle.js";

it("filters real project, suggestion and metadata replies using current invited membership", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ state, sender, invited, carol, providerRequests }) => {
      const { key } = await sender.request<{ key: string }>(
        "sessions.create",
        { agentId: "main", visibility: "shared" },
        { signal },
      );
      const repo = await initializeRepository(state.root, "invited-checkout");
      await patchSessionEntryCore({ agentId: "main", sessionKey: key }, () => ({ execCwd: repo }));
      const { taskId } = await sender.request<{ taskId: string }>(
        "taskSuggestions.create",
        {
          agentId: "main",
          sessionKey: key,
          title: "Review checkout",
          tldr: "Review this checkout",
          prompt: "Review the change",
          cwd: repo,
        },
        { signal },
      );
      const membership = (method: "add" | "remove") =>
        sender.request(
          `session.members.${method}`,
          { sessionKey: key, agentId: "main", identityId: carol.id },
          { signal },
        );
      const projects = () =>
        invited.request<{
          observedProjects: { checkouts: { path: string }[] }[];
        }>("projects.list", { includeObserved: true }, { signal });
      const suggestions = () =>
        invited.request<{ suggestions: { id: string }[] }>(
          "taskSuggestions.list",
          { agentId: "main" },
          { signal },
        );
      const metadata = () =>
        invited.request<{ commands: unknown[] }>(
          "chat.metadata",
          { sessionKey: key, agentId: "main" },
          { signal },
        );
      const paths = (result: Awaited<ReturnType<typeof projects>>) =>
        result.observedProjects.flatMap((project) =>
          project.checkouts.map((checkout) => checkout.path),
        );

      expect(paths(await projects())).not.toContain(repo);
      expect((await suggestions()).suggestions).toEqual([]);
      await expect(metadata()).rejects.toThrow(/not found/i);
      await membership("add");
      // Cold repository discovery publishes its result after the first listing.
      await expect.poll(async () => paths(await projects())).toContain(repo);
      expect((await suggestions()).suggestions.map(({ id }) => id)).toContain(taskId);
      expect((await metadata()).commands).toBeInstanceOf(Array);

      const projectEntered = createDeferred();
      const suggestionEntered = createDeferred();
      const release = createDeferred();
      const resolveIdentities = managedWorktrees.resolveRepositoryIdentities.bind(managedWorktrees);
      using cleanup = new DisposableStack();
      cleanup.use(
        vi
          .spyOn(managedWorktrees, "resolveRepositoryIdentities")
          .mockImplementationOnce(async (...args) => {
            const result = await resolveIdentities(...args);
            projectEntered.resolve();
            await release.promise;
            return result;
          }),
      );
      const prepare = sharing.prepareSessionMutationFacts;
      cleanup.use(
        vi.spyOn(sharing, "prepareSessionMutationFacts").mockImplementationOnce(async (...args) => {
          const result = await prepare(...args);
          suggestionEntered.resolve();
          await release.promise;
          return result;
        }),
      );
      const projectRead = projects();
      const suggestionRead = suggestions();
      void projectRead.catch(() => {});
      void suggestionRead.catch(() => {});
      try {
        await withinTest(
          Promise.all([
            awaitGateBeforeSettlement(
              projectEntered.promise,
              projectRead,
              "project reply skipped discovery",
            ),
            awaitGateBeforeSettlement(
              suggestionEntered.promise,
              suggestionRead,
              "suggestion reply skipped source preparation",
            ),
          ]),
          signal,
        );
        await membership("remove");
        release.resolve();
        await expect(projectRead).rejects.toThrow(/access changed/i);
        await expect(suggestionRead).rejects.toMatchObject({ code: "UNAVAILABLE" });
      } finally {
        release.resolve();
        await Promise.allSettled([projectRead, suggestionRead]);
      }
      expect(paths(await projects())).not.toContain(repo);
      expect((await suggestions()).suggestions).toEqual([]);

      await membership("add");
      const sessionId = loadSessionEntry({ agentId: "main", sessionKey: key })!.sessionId;
      const metadataEntered = createDeferred();
      const metadataRelease = createDeferred();
      const readPlacement = placement.readSessionWorkerPlacementAsync;
      let armed = true;
      cleanup.use(
        vi
          .spyOn(placement, "readSessionWorkerPlacementAsync")
          .mockImplementation(async (params) => {
            const result = await readPlacement(params);
            if (armed && params.sessionId === sessionId) {
              armed = false;
              metadataEntered.resolve();
              await metadataRelease.promise;
            }
            return result;
          }),
      );
      const pendingMetadata = metadata();
      void pendingMetadata.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            metadataEntered.promise,
            pendingMetadata,
            "metadata reply skipped placement preparation",
          ),
          signal,
        );
        await membership("remove");
        metadataRelease.resolve();
        await expect(pendingMetadata).rejects.toMatchObject({ code: "UNAVAILABLE" });
      } finally {
        metadataRelease.resolve();
        await Promise.allSettled([pendingMetadata]);
      }
      // Metadata consumes the published catalog; inference has a separate transport proof.
      expect(providerRequests).toEqual([]);
    },
  );
});
