import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import sessionSharePlugin from "../../../../extensions/session-share/index.js";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { setRuntimeConfigSnapshot } from "../../../../src/config/runtime-snapshot.js";
import {
  assignSessionOwner,
  replaceSessionEntry,
} from "../../../../src/config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../../../src/config/sessions/session-accessor.sqlite-participants.native.js";
import type { InternalSessionEntry as SessionEntry } from "../../../../src/config/sessions/types.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { ensureProfileForEmail } from "../../../../src/state/user-profiles.js";
import { withNodeGateway } from "./node-gateway-fixture.js";

const COMMANDS = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];

it(
  "publishes source-selected sessions through a paired node and rechecks transcript disclosure",
  { timeout: 180_000 },
  async () => {
    await withNodeGateway(
      {
        label: "session-share-node",
        receiver: "child",
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
      async ({ config, operator, node, nodeId, invocations }) => {
        const person = ensureProfileForEmail("selected@example.test");
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
        const list = () =>
          vi.waitUntil(
            async () => {
              const result = await operator.request<SessionsCatalogListResult>(
                "sessions.catalog.list",
                { catalogId: "openclaw", hostIds: [hostId], limitPerHost: 100 },
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
          });
        const sourceRequests = vi.spyOn(node, "request");
        try {
          // This stored row and source config have neither a person selector nor identity metadata.
          await write("group-only", {}, "Existing group-only transcript");
          const legacy = await list();
          expect(legacy.catalogs.find(({ id }) => id === "openclaw")?.hosts).toMatchObject([
            { hostId, sessions: [{ threadId: scope("group-only").sessionKey }] },
          ]);
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
          config.plugins!.entries!["session-share"]!.config = {
            share: { groups: ["Team"], involvingProfileId: person.id },
          };
          setRuntimeConfigSnapshot(config);

          const filtered = await list();
          const host = filtered.catalogs
            .find(({ id }) => id === "openclaw")
            ?.hosts.find((candidate) => candidate.hostId === hostId);
          expect(host?.error).toBeUndefined();
          expect(host?.sessions.map(({ threadId }) => threadId).toSorted()).toEqual([
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
          for (const denied of ["group-only", "mention", "unrelated", "other-group"]) {
            await expect(read(denied)).rejects.toThrow(/not visible|not shared/i);
          }
          // Emit only synthetic fixture effects so hosted proof is inspectable without
          // copying device identities, tokens, paths, or unbounded protocol frames.
          console.info(
            "[session-share-node] " +
              JSON.stringify({
                listed: host?.sessions.map(({ threadId }) => threadId),
                delivered: [ownerRead, participantRead].map(({ items }) =>
                  items.map(({ type, ...item }) => ({
                    type,
                    ...("text" in item ? { text: item.text } : {}),
                  })),
                ),
                rejected: ["group-only", "mention", "unrelated", "other-group"],
              }),
          );

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
