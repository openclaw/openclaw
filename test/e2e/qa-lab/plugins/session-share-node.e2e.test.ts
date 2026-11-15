import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import sessionSharePlugin from "../../../../extensions/session-share/index.js";
import type {
  SessionsCatalogListResult,
  SessionCatalogProfileRelation,
  SessionsCatalogReadResult,
  SessionsCatalogImportResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import {
  assignSessionOwner,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../../src/config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../../../src/config/sessions/session-accessor.sqlite-participants.native.js";
import type { InternalSessionEntry as SessionEntry } from "../../../../src/config/sessions/types.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { syncCanonicalGitHubIdentity } from "../../../../src/state/user-profile-writes.js";
import { syncGitHubIdentity } from "../../../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../../src/state/user-profiles.js";
import { withNodeGateway } from "./node-gateway-fixture.js";

const COMMANDS = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];

it(
  "pulls caller-selected relationships through a paired node and rechecks transcript disclosure",
  { timeout: 180_000 },
  async () => {
    const alice = "alice@example.test";
    const bob = "bob@example.test";
    const carol = "carol@example.test";
    const missing = "unlinked@example.test";
    let receiverPersonId: string | undefined;
    await withNodeGateway(
      {
        label: "session-share-node",
        onPhase: (phase) => console.info(`[session-share-node] ${phase}`),
        receiver: "child",
        receiverUsers: {
          [alice]: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
          [bob]: ["operator.read"],
          [carol]: ["operator.read"],
          [missing]: ["operator.read"],
        },
        prepareReceiverState: async (env) => {
          const profile = await syncCanonicalGitHubIdentity(
            {
              identity: { accountId: 701, login: "selected-query-person" },
              authenticationAlias: { kind: "email", email: alice },
            },
            { env },
          );
          receiverPersonId = profile.id;
        },
        plugin: sessionSharePlugin,
        platform: process.platform,
        caps: ["openclaw-sessions"],
        commands: COMMANDS,
        config: () => ({
          gateway: { nodes: { commands: { allow: COMMANDS } } },
          agents: { entries: { main: {} }, defaults: { skipBootstrap: true } },
          plugins: {
            allow: ["session-share"],
            slots: { memory: "none" },
            entries: {
              "session-share": { enabled: true, config: { share: { groups: ["Team"] } } },
            },
          },
        }),
      },
      async ({ config, operator, node, nodeId, invocations, connectReader }) => {
        const person = syncGitHubIdentity({
          identity: { accountId: 701, login: "selected-query-person" },
          authenticationAlias: { kind: "email", email: "selected-source@example.test" },
        });
        const self = await operator.request<{ profile: { id: string } }>("users.self", {});
        expect(self.profile.id).toBe(receiverPersonId);
        expect(person.id).not.toBe(self.profile.id);
        const bobReader = await connectReader(bob);
        const carolReader = await connectReader(carol);
        const unlinkedReader = await connectReader(missing);
        const other = ensureProfileForEmail("other@example.test");
        const actor = { type: "human", source: "profile", id: person.id } as const;
        const hostId = `node:${nodeId}`;
        const scope = (name: string) => ({
          agentId: "main",
          sessionKey: `agent:main:${name}`,
          sessionId: name,
        });
        const write = async (name: string, patch: Partial<SessionEntry> = {}, text = name) => {
          const target = scope(name);
          const entry: SessionEntry = {
            sessionId: name,
            updatedAt: Date.now(),
            label: name,
            category: "Team",
            ...patch,
          };
          await replaceSessionEntry(target, entry);
          await appendSessionTranscriptMessageByIdentity({
            ...target,
            message: { role: "user", content: text },
          });
          return { target, entry };
        };
        let profileRelation: SessionCatalogProfileRelation | undefined;
        const list = (
          reader = operator,
          query: SessionCatalogProfileRelation | null | undefined = profileRelation,
        ) =>
          vi.waitUntil(
            async () => {
              const result = await reader.request<SessionsCatalogListResult>(
                "sessions.catalog.list",
                {
                  catalogId: "openclaw",
                  hostIds: [hostId],
                  limitPerHost: 100,
                  pollId: "proof",
                  ...(query ? { profileRelation: query } : {}),
                },
              );
              const catalog = result.catalogs.find(({ id }) => id === "openclaw");
              const context = JSON.stringify({ catalog, invocations });
              expect(catalog, context).toBeDefined();
              expect(catalog?.error, context).toBeUndefined();
              for (const host of catalog!.hosts) {
                expect(host.error, context).toBeUndefined();
              }
              // The RPC budget can expire before source discovery settles. Retry only
              // an explicit pending result; errors and settled empty lists must fail.
              return catalog!.pending || catalog!.hosts.some((host) => host.pending)
                ? false
                : result;
            },
            { timeout: 30_000, interval: 100 },
          );
        const read = (name: string) =>
          operator.request<SessionsCatalogReadResult>("sessions.catalog.read", {
            catalogId: "openclaw",
            hostId,
            threadId: scope(name).sessionKey,
            ...(profileRelation ? { profileRelation } : {}),
          });
        const sourceRequests = vi.spyOn(node, "request");
        try {
          const beforeMissingLink = invocations.length;
          await expect(
            unlinkedReader.request("sessions.catalog.list", {
              catalogId: "openclaw",
              profileRelation: { relationship: "involving", target: { type: "me" } },
            }),
          ).rejects.toThrow(/verified GitHub|authenticated human/);
          expect(invocations).toHaveLength(beforeMissingLink);
          // This stored row and source config have neither a person selector nor identity metadata.
          await write("group-only", {}, "Existing group-only transcript");
          expect((await read("group-only")).items).toMatchObject([
            { type: "userMessage", text: "Existing group-only transcript" },
          ]);

          await write("owner", { createdActor: actor }, "Allowed owner transcript");
          await write("participant");
          recordSessionParticipant(scope("participant"), {
            identity: { type: "profile", id: person.id },
            promptedAt: Date.now(),
          });
          await write("mention", {
            profileInvolvement: {
              key: scope("mention").sessionKey,
              profiles: {
                [person.id]: {
                  hidden: true,
                  updatedAt: Date.now(),
                  lastMention: { generation: "fixture", sequence: 1, timestamp: Date.now() },
                },
              },
            },
          });
          await write("unrelated", { label: person.id });
          await write("other-group", { category: "Other", createdActor: actor });
          profileRelation = { relationship: "involving", target: { type: "me" } };
          const firstFilteredInvocation = invocations.length;
          const filtered = await list();
          const host = filtered.catalogs
            .find(({ id }) => id === "openclaw")
            ?.hosts.find((candidate) => candidate.hostId === hostId);
          expect(host?.error).toBeUndefined();
          expect(host?.sessions.map(({ threadId }) => threadId).toSorted()).toEqual([
            scope("mention").sessionKey,
            scope("owner").sessionKey,
            scope("participant").sessionKey,
          ]);
          const ownerRead = await read("owner");
          expect(ownerRead.items).toMatchObject([
            { type: "userMessage", text: "Allowed owner transcript" },
          ]);
          const participantRead = await read("participant");
          expect(participantRead.items).toMatchObject([
            { type: "userMessage", text: "participant" },
          ]);
          const mentionRead = await read("mention");
          expect(mentionRead.items).toMatchObject([{ type: "userMessage", text: "mention" }]);
          for (const denied of ["group-only", "unrelated", "other-group"]) {
            await expect(read(denied)).rejects.toThrow(/not visible|not shared/i);
          }
          // Emit only synthetic fixture effects so hosted proof is inspectable without
          // copying device identities, tokens, paths, or unbounded protocol frames.
          console.info(
            "[session-share-node] " +
              JSON.stringify({
                listed: host?.sessions.map(({ threadId }) => threadId),
                delivered: [ownerRead, participantRead, mentionRead].map(({ items }) =>
                  items.map(({ type, ...item }) => ({
                    type,
                    ...("text" in item ? { text: item.text } : {}),
                  })),
                ),
                rejected: ["group-only", "unrelated", "other-group"],
              }),
          );

          const portableQuery = {
            relationship: "involving",
            target: { type: "github-account", id: "701" },
          };
          const filteredRequests = invocations
            .slice(firstFilteredInvocation)
            .filter(({ command }) => command === COMMANDS[0]);
          expect(filteredRequests.length).toBeGreaterThan(0);
          for (const { params } of filteredRequests) {
            expect(params).toMatchObject({ profileRelation: portableQuery });
          }
          profileRelation = { relationship: "owned", target: { type: "profile", id: person.id } };
          const owned = await list(bobReader);
          expect(owned.catalogs[0]?.hosts[0]?.sessions.map(({ threadId }) => threadId)).toEqual([
            scope("owner").sessionKey,
          ]);
          const beforeImport = invocations.length;
          const imported = await operator.request<SessionsCatalogImportResult>(
            "sessions.catalog.import",
            { catalogId: "openclaw", hostId, threadId: scope("owner").sessionKey, profileRelation },
          );
          expect(imported).toMatchObject({
            complete: true,
            created: true,
            importedItems: 1,
            totalItems: 1,
          });
          // Imports belong to the receiver agent, not the source session's main agent.
          expect(imported.sessionKey).toMatch(/^agent:qa:catalog-import:/);
          const importReads = invocations
            .slice(beforeImport)
            .filter(({ command }) => command === COMMANDS[1]);
          expect(importReads.length).toBeGreaterThan(0);
          for (const { params } of importReads) {
            expect(params).toMatchObject({ threadId: scope("owner").sessionKey, profileRelation });
          }
          await expect(
            operator.request("sessions.catalog.import", {
              catalogId: "openclaw",
              hostId,
              threadId: scope("participant").sessionKey,
              profileRelation,
            }),
          ).rejects.toThrow(/not visible|not shared/i);
          profileRelation = undefined;
          const unfiltered = await list(carolReader, null);
          expect(
            unfiltered.catalogs[0]?.hosts[0]?.sessions.map(({ threadId }) => threadId),
          ).toContain(scope("unrelated").sessionKey);
          expect(config.plugins?.entries?.["session-share"]?.config).toEqual({
            share: { groups: ["Team"] },
          });
          // The same canonical source target also works explicitly. It replaces
          // only Alice's polling scope; Bob and Carol retain their own selections.
          const explicitQuery: SessionCatalogProfileRelation = {
            relationship: "involving",
            target: { type: "profile", id: person.id },
          };
          expect(
            (await list(operator, explicitQuery)).catalogs[0]?.hosts[0]?.sessions,
          ).toHaveLength(3);
          // Exceed the actual node page size, with unrelated data already present.
          // The receiving owner must pull two filtered pages, never an unfiltered prefix.
          for (let index = 0; index < 98; index++) {
            replaceSessionEntrySync(scope(`page-${index}`), {
              sessionId: `page-${index}`,
              updatedAt: index + 1,
              category: "Team",
              createdActor: actor,
            });
          }
          profileRelation = { relationship: "involving", target: { type: "me" } };
          const beforePages = invocations.length;
          const paged = await list();
          const firstPage = paged.catalogs[0]!.hosts[0]!;
          expect(firstPage.sessions).toHaveLength(100);
          expect(firstPage.nextCursor).toBeDefined();
          const secondPage = await operator.request<SessionsCatalogListResult>(
            "sessions.catalog.list",
            {
              catalogId: "openclaw",
              hostIds: [hostId],
              pollId: "proof",
              profileRelation,
              cursors: { [hostId]: firstPage.nextCursor! },
            },
          );
          expect(secondPage.catalogs[0]?.hosts[0]?.sessions).toHaveLength(1);
          const allRows = [...firstPage.sessions, ...secondPage.catalogs[0]!.hosts[0]!.sessions];
          expect(new Set(allRows.map(({ threadId }) => threadId)).size).toBe(101);
          expect(allRows.map(({ threadId }) => threadId)).not.toContain(
            scope("unrelated").sessionKey,
          );
          const pageRequests = invocations
            .slice(beforePages)
            .filter(
              ({ command, params }) =>
                command === COMMANDS[0] &&
                isRecord(params) &&
                JSON.stringify(params.profileRelation) === JSON.stringify(portableQuery),
            );
          expect(
            pageRequests.some(
              ({ params }) => isRecord(params) && typeof params.cursor === "string",
            ),
          ).toBe(true);
          const beforePoll = invocations.length;
          // No foreground list triggers these: the existing service scheduler
          // must retain all three callers' normalized selections on its next tick.
          await vi.waitUntil(
            () => {
              const requests = invocations
                .slice(beforePoll)
                .filter(({ command }) => command === COMMANDS[0]);
              return [
                portableQuery,
                { relationship: "owned", target: { type: "profile", id: person.id } },
                undefined,
              ].every((query) =>
                requests.some(
                  ({ params }) =>
                    isRecord(params) &&
                    JSON.stringify(params.profileRelation) === JSON.stringify(query),
                ),
              );
            },
            { timeout: 35_000, interval: 100 },
          );
          profileRelation = { relationship: "owned", target: { type: "profile", id: person.id } };
          for (const change of ["group", "owner"] as const) {
            const marker = `Withheld ${change} transcript`;
            const { target, entry } = await write(
              `revoke-${change}`,
              { createdActor: actor },
              marker,
            );
            const entered = createDeferredCore();
            const release = createDeferredCore();
            const readPage = transcriptRuntime.readSessionTranscriptCatalogPage;
            // Hold actual prepared bytes, not a synthetic page. Only the final source guard
            // can keep them out of the real node result and receiver RPC after revocation.
            const held = vi
              .spyOn(transcriptRuntime, "readSessionTranscriptCatalogPage")
              .mockImplementationOnce(async (...args) => {
                const page = await readPage(...args);
                entered.resolve();
                await release.promise;
                return page;
              });
            const firstRequest = sourceRequests.mock.calls.length;
            const pending = read(`revoke-${change}`);
            try {
              await Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Transcript preparation was not held");
                }),
              ]);
              if (change === "group") {
                await replaceSessionEntry(target, { ...entry, category: "Private" });
              } else {
                assignSessionOwner(target, {
                  owner: { type: "human", id: other.id },
                  assignedBy: { type: "human", id: person.id },
                });
              }
            } finally {
              release.resolve();
              held.mockRestore();
            }
            await expect(pending).rejects.toThrow();
            const results = sourceRequests.mock.calls
              .slice(firstRequest)
              .filter(([method]) => method === "node.invoke.result")
              .map(([, result]) => result);
            expect(results.filter((result) => isRecord(result) && result.ok === false)).toEqual([
              expect.objectContaining({
                ok: false,
                error: expect.objectContaining({
                  message: expect.stringMatching(/no longer shared/i),
                }),
              }),
            ]);
            expect(JSON.stringify(results)).not.toContain(marker);
            console.info(
              "[session-share-node] " +
                JSON.stringify({
                  revoked: change,
                  receiver: "rejected",
                  nodeResults: results.map((result) => (isRecord(result) ? result.ok : null)),
                  heldTranscriptInNodeResult: JSON.stringify(results).includes(marker),
                }),
            );
          }
          expect(invocations.map(({ command }) => command)).toEqual(
            expect.arrayContaining(COMMANDS),
          );
          const resultIds = sourceRequests.mock.calls
            .filter(([method]) => method === "node.invoke.result")
            .map(([, result]) => (isRecord(result) ? result.id : undefined));
          expect(resultIds).not.toContain(undefined);
          expect(new Set(resultIds).size).toBe(resultIds.length);
        } finally {
          sourceRequests.mockRestore();
        }
      },
    );
  },
);
