import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignSessionOwner,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../src/config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../src/config/sessions/session-accessor.sqlite-participants.native.js";
import { SessionEntryChangedDuringReadError } from "../../src/config/sessions/session-entry-read-errors.js";
import {
  projectionLane,
  targetDiscoveryLane,
} from "../../src/config/sessions/session-transcript-worker-resources.js";
import type { InternalSessionEntry as SessionEntry } from "../../src/config/sessions/types.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import * as profileReads from "../../src/state/user-profile-list.js";
import { linkEmail } from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { observeHostDataSql } from "../helpers/sqlite-statement-execution-counter.js";
import { commandFixture } from "./session-share.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("session-share source publication filters", () => {
  it("requires groups, narrows to canonical owners or participants, and preserves exclusions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      const person = ensureProfileForEmail("person@example.test");
      const alias = ensureProfileForEmail("alias@example.test");
      const other = ensureProfileForEmail("other@example.test");
      linkEmail("alias@example.test", person.id);
      const participant = { identity: { type: "profile", id: alias.id } } as const;
      const createdActor = { type: "human", source: "profile", id: alias.id } as const;
      const now = Date.now();
      const mention = {
        hidden: true,
        updatedAt: now,
        lastMention: { generation: "fixture", sequence: 1, timestamp: now },
      };
      const rows: Record<string, Partial<SessionEntry>> = {
        creator: { createdActor },
        owner: {
          owner: { actor: { type: "human", id: alias.id } },
          profileInvolvement: { key: "agent:main:owner", profiles: { [alias.id]: mention } },
        },
        participant: { participants: [participant] },
        mention: {
          profileInvolvement: { key: "agent:main:mention", profiles: { [alias.id]: mention } },
        },
        ungrouped: { category: undefined, participants: [participant] },
        othergroup: { category: "Other", participants: [participant] },
        reassigned: { createdActor, owner: { actor: { type: "human", id: other.id } } },
        personalonly: {
          profileInvolvement: {
            key: "agent:main:personalonly",
            profiles: { [person.id]: { hidden: false, updatedAt: now } },
          },
        },
        legacy: { createdActor: { type: "human", source: "channel", id: person.id } },
        remote: {
          participants: [
            {
              identity: {
                type: "remote",
                pluginId: "fixture",
                domain: "fixture",
                idKind: "profile",
                id: person.id,
              },
            },
          ],
        },
        unrelated: { label: person.id },
        draft: { participants: [participant], visibility: "draft" },
        incognito: { participants: [participant], incognito: true },
        "catalog:external": { participants: [participant] },
        "subagent:child": { participants: [participant] },
        spawned: { participants: [participant], createdVia: "spawn" },
        resumed: { participants: [participant], spawnedBy: "agent:main:parent" },
      };
      for (const [name, patch] of Object.entries(rows)) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: `agent:main:${name}` },
          {
            sessionId: name,
            updatedAt: now,
            category: "Team",
            label: name,
            ...patch,
          },
        );
        const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
        for (const { identity } of patch.participants ?? []) {
          recordSessionParticipant(scope, { identity, promptedAt: now });
        }
        if (patch.owner?.actor.id) {
          assignSessionOwner(scope, {
            owner: { ...patch.owner.actor, id: patch.owner.actor.id },
            assignedBy: { type: "human", id: person.id },
          });
        }
      }
      const listed = async () =>
        (await fixture.list()).sessions
          .map(({ threadId }) => threadId.slice("agent:main:".length))
          .toSorted((left, right) => left.localeCompare(right));
      fixture.select({ involvingProfileId: person.id });
      expect(await listed()).toEqual([]);
      await expect(fixture.read("agent:main:participant")).rejects.toThrow("not shared");
      // An exact merge alias names the same canonical person; it is not a display-prefix match.
      fixture.select({ groups: ["Team"], involvingProfileId: alias.id });
      expect(await listed()).toEqual(["creator", "owner", "participant"]);
      fixture.select({ groups: ["Team", "Other"], involvingProfileId: person.id });
      expect(await listed()).toEqual(["creator", "othergroup", "owner", "participant"]);
      for (const name of [
        "mention",
        "reassigned",
        "personalonly",
        "legacy",
        "remote",
        "unrelated",
        "draft",
        "incognito",
        "catalog:external",
        "subagent:child",
        "spawned",
        "resumed",
        "ungrouped",
      ]) {
        await expect(fixture.read(`agent:main:${name}`)).rejects.toThrow("not shared");
      }
      await expect(fixture.list({ involvingProfileId: other.id })).rejects.toThrow("Unknown");
      // Identity references are exact, even if a shorter prefix happens to be unique today.
      for (const involvingProfileId of [
        "unknown",
        "person@example.test",
        person.id.slice(0, 8),
        person.id.replaceAll("-", ""),
      ]) {
        fixture.select({ groups: ["Team"], involvingProfileId });
        expect(await listed()).toEqual([]);
        await expect(fixture.read("agent:main:participant")).rejects.toThrow("not shared");
      }
    });
  });

  it("refuses a shared list when an earlier store revokes its group during a later read", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      fixture.config.agents = { entries: { main: {}, other: {} } };
      const first = { agentId: "main", sessionKey: "agent:main:shared" };
      const entry = { sessionId: "first-shared", updatedAt: 1, category: "Team" };
      await replaceSessionEntry(first, entry);
      await replaceSessionEntry(
        { agentId: "other", sessionKey: "agent:other:shared" },
        { sessionId: "second-shared", updatedAt: 2, category: "Team" },
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const held = [projectionLane, targetDiscoveryLane].map(({ pool }) => {
        const run = pool.run.bind(pool);
        return vi.spyOn(pool, "run").mockImplementation(async (input, controls) => {
          const request = typeof input === "function" ? await input() : input;
          if (request.kind === "session-exact-entries" && request.database.agentId === "other") {
            entered.resolve();
            await release.promise;
          }
          return run(request, controls);
        });
      });
      const pending = fixture.list().then(
        (page) => ({ page }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Second store read was not held");
          }),
        ]);
        replaceSessionEntrySync(first, { ...entry, category: "Private" });
        release.resolve();
        expect(await pending).toEqual({ error: expect.any(SessionEntryChangedDuringReadError) });
      } finally {
        release.resolve();
        await pending;
        for (const spy of held) {
          spy.mockRestore();
        }
      }
    });
  });

  it("revokes transcript publication when involvement or configured selection changes during a read", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      const person = ensureProfileForEmail("reader@example.test");
      const scope = { agentId: "main", sessionKey: "agent:main:involved", sessionId: "involved" };
      const entry: SessionEntry = {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        category: "Team",
        createdActor: { type: "human", source: "profile", id: person.id },
        profileInvolvement: {
          key: scope.sessionKey,
          profiles: {
            [person.id]: {
              hidden: false,
              updatedAt: Date.now(),
              lastMention: { generation: "fixture", sequence: 1, timestamp: Date.now() },
            },
          },
        },
      };
      fixture.select({ groups: ["Team"], involvingProfileId: person.id });
      await replaceSessionEntry(scope, entry);
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: "Shared question" },
      });
      expect((await fixture.read(scope.sessionKey)).items).toMatchObject([
        { type: "userMessage", text: "Shared question" },
      ]);
      for (const change of ["config", "membership"]) {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const readPage = transcriptRuntime.readSessionTranscriptCatalogPage;
        const held = vi
          .spyOn(transcriptRuntime, "readSessionTranscriptCatalogPage")
          .mockImplementationOnce(async (...args) => {
            const page = await readPage(...args);
            entered.resolve();
            await release.promise;
            return page;
          });
        const pending = fixture.read(scope.sessionKey);
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Transcript was not held");
            }),
          ]);
          if (change === "config") {
            fixture.select({ involvingProfileId: person.id });
          } else {
            const other = ensureProfileForEmail("replacement@example.test");
            assignSessionOwner(scope, {
              owner: { type: "human", id: other.id },
              assignedBy: { type: "human", id: person.id },
            });
          }
        } finally {
          release.resolve();
        }
        await expect(pending).rejects.toThrow("no longer shared");
        held.mockRestore();
        fixture.select({ groups: ["Team"], involvingProfileId: person.id });
      }
      expect((await fixture.list()).sessions).toEqual([]);
      await expect(fixture.read(scope.sessionKey)).rejects.toThrow("not shared");
    });
  });

  it("resolves the filtered runtime reader's identities in its explicit environment", async () => {
    await withOpenClawTestState({ scenario: "minimal", applyEnv: false }, async ({ env }) => {
      setRuntimeConfigSnapshot({});
      const profile = ensureProfileForEmail("scoped@example.test", { env });
      const scope = { agentId: "main", sessionKey: "agent:main:scoped", env };
      replaceSessionEntrySync(scope, {
        sessionId: "scoped",
        updatedAt: Date.now(),
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:mentiononly" },
        {
          sessionId: "mentiononly",
          updatedAt: Date.now(),
          profileInvolvement: {
            key: "agent:main:mentiononly",
            profiles: {
              [profile.id]: {
                hidden: false,
                updatedAt: Date.now(),
                lastMention: { generation: "fixture", sequence: 1, timestamp: Date.now() },
              },
            },
          },
        },
      );
      const runtime = createPluginRuntime();
      const stores = [
        {
          agentId: "main",
          storePath: runtime.agent.session.resolveStorePath(undefined, { agentId: "main", env }),
          sessionKeys: [scope.sessionKey, "agent:main:mentiononly"],
        },
      ];
      const sql = observeHostDataSql();
      try {
        expect(
          await runtime.agent.session.withSessionEntriesAsync(
            { stores, env, involvingProfileId: profile.id },
            (entries) => entries.map(({ sessionKey }) => sessionKey),
          ),
        ).toEqual([scope.sessionKey]);
        expect(
          await runtime.agent.session.withSessionEntriesAsync(
            { stores, env, involvingProfileId: "" },
            (entries) => entries,
          ),
        ).toEqual([]);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  });

  it("releases prepared profile catalogs after success, consumer failure, and async misuse", async () => {
    await withOpenClawTestState({ scenario: "minimal", applyEnv: false }, async ({ env }) => {
      setRuntimeConfigSnapshot({});
      const person = ensureProfileForEmail("lease@example.test", { env });
      const runtime = createPluginRuntime();
      const sessionKey = "agent:main:lease";
      await replaceSessionEntry(
        { agentId: "main", sessionKey, env },
        {
          sessionId: "lease",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: person.id },
        },
      );
      const prepare = profileReads.prepareUserProfileCatalog;
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      vi.spyOn(profileReads, "prepareUserProfileCatalog").mockImplementation(async (options) => {
        const catalog = await prepare(options);
        const release = vi.fn(catalog.release);
        releases.push(release);
        return { ...catalog, release };
      });
      const params = {
        env,
        involvingProfileId: person.id,
        stores: [
          {
            agentId: "main",
            storePath: runtime.agent.session.resolveStorePath(undefined, { agentId: "main", env }),
            sessionKeys: [sessionKey],
          },
        ],
      };
      const consume = runtime.agent.session.withSessionEntriesAsync;
      expect(await consume(params, (entries) => entries.length)).toBe(1);
      await expect(
        consume(params, () => {
          throw new Error("consumer failed");
        }),
      ).rejects.toThrow("consumer failed");
      await expect(consume(params, async () => "late")).rejects.toThrow("must remain synchronous");
      expect(releases).toHaveLength(3);
      for (const release of releases) {
        expect(release).toHaveBeenCalledTimes(1);
      }
    });
  });

  it.each(["list", "read"] as const)(
    "rechecks in-place configuration after the final %s worker preparation",
    async (command) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const fixture = commandFixture();
        const person = ensureProfileForEmail("final-worker@example.test");
        const sessionKey = "agent:main:final-worker";
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: "final-worker",
            updatedAt: 1,
            category: "Team",
            createdActor: { type: "human", source: "profile", id: person.id },
          },
        );
        fixture.select({ groups: ["Team"], involvingProfileId: person.id });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const original = fixture.runtime.agent.session.withSessionEntriesAsync;
        let calls = 0;
        vi.spyOn(fixture.runtime.agent.session, "withSessionEntriesAsync").mockImplementation(
          async (params, consume) => {
            if (++calls === 2) {
              entered.resolve();
              await release.promise;
            }
            return original(params, consume);
          },
        );
        const pending = command === "list" ? fixture.list() : fixture.read(sessionKey);
        const rejected = expect(pending).rejects.toThrow("no longer shared");
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Final worker was not held");
            }),
          ]);
          fixture.select({ groups: [], involvingProfileId: person.id });
        } finally {
          release.resolve();
        }
        await rejected;
        expect(calls).toBe(2);
      });
    },
  );

  it("validates selector config and never broadens empty or malformed filters", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      const person = ensureProfileForEmail("selected@example.test");
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:selected" },
        {
          sessionId: "selected",
          updatedAt: Date.now(),
          category: "Team",
          createdActor: { type: "human", source: "profile", id: person.id },
        },
      );
      const manifest = JSON.parse(
        fs.readFileSync(
          new URL("../../extensions/session-share/openclaw.plugin.json", import.meta.url),
          "utf8",
        ),
      ) as { configSchema: Record<string, unknown> };
      for (const share of [
        { groups: ["Team"] },
        { groups: ["Team"], involvingProfileId: person.id },
      ]) {
        expect(
          validateJsonSchemaValue({
            schema: manifest.configSchema,
            cacheKey: "session-share.filters",
            value: { share },
          }).ok,
        ).toBe(true);
        fixture.select(share);
        for (const command of fixture.commands) {
          expect(command.isAvailable?.({ config: fixture.config, env: {} })).toBe(true);
        }
        expect((await fixture.list()).sessions).toHaveLength(1);
      }
      for (const share of [
        { involvingProfileId: person.id },
        {},
        { groups: [] },
        { groups: [], involvingProfileId: person.id },
        { groups: ["Team", ""] },
        { groups: "Team", involvingProfileId: person.id },
        { groups: ["Team"], involvingProfileId: "" },
        { groups: ["Team"], involvingProfileId: " " },
        { groups: ["Team"], involvingProfileId: null },
      ]) {
        fixture.select(share);
        for (const command of fixture.commands) {
          expect(command.isAvailable?.({ config: fixture.config, env: {} })).toBe(false);
        }
        expect((await fixture.list()).sessions).toEqual([]);
        await expect(fixture.read("agent:main:selected")).rejects.toThrow("not shared");
      }
      for (const share of [
        { involvingProfileId: person.id },
        {},
        { involvingProfileId: "" },
        { involvingProfileId: " " },
        { involvingMe: true },
        { involvingProfileId: null },
      ]) {
        expect(
          validateJsonSchemaValue({
            schema: manifest.configSchema,
            cacheKey: "session-share.filters",
            value: { share },
          }).ok,
        ).toBe(false);
      }
    });
  });
});
