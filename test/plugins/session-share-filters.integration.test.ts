import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it } from "vitest";
import {
  assignSessionOwner,
  replaceSessionEntry,
} from "../../src/config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../src/config/sessions/session-accessor.sqlite-participants.native.js";
import type { InternalSessionEntry as SessionEntry } from "../../src/config/sessions/types.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { ensureProfileForEmail, linkEmail } from "../../src/state/user-profiles.js";
import { commandFixture } from "./session-share.test-support.js";

describe("session-share source publication filters", () => {
  it("selects canonical person involvement, intersects groups, and preserves safety exclusions", async () => {
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
        owner: { owner: { actor: { type: "human", id: alias.id } } },
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
      expect(await listed()).toEqual([
        "creator",
        "mention",
        "othergroup",
        "owner",
        "participant",
        "ungrouped",
      ]);
      // An exact merge alias names the same canonical person; it is not a display-prefix match.
      fixture.select({ groups: ["Team"], involvingProfileId: alias.id });
      expect(await listed()).toEqual(["creator", "mention", "owner", "participant"]);
      fixture.select({ groups: ["Team", "Other"], involvingProfileId: person.id });
      expect(await listed()).toEqual(["creator", "mention", "othergroup", "owner", "participant"]);
      for (const name of [
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
      };
      fixture.select({ involvingProfileId: person.id });
      await replaceSessionEntry(scope, entry);
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: "Shared question" },
      });
      expect((await fixture.read(scope.sessionKey)).items).toMatchObject([
        { type: "userMessage", text: "Shared question" },
      ]);
      const configRead = fixture.read(scope.sessionKey);
      fixture.select({ groups: [], involvingProfileId: person.id });
      await expect(configRead).rejects.toThrow("no longer shared");
      fixture.select({ involvingProfileId: person.id });
      const membershipRead = fixture.read(scope.sessionKey);
      const other = ensureProfileForEmail("replacement@example.test");
      assignSessionOwner(scope, {
        owner: { type: "human", id: other.id },
        assignedBy: { type: "human", id: person.id },
      });
      await expect(membershipRead).rejects.toThrow("no longer shared");
      expect((await fixture.list()).sessions).toEqual([]);
      await expect(fixture.read(scope.sessionKey)).rejects.toThrow("not shared");
    });
  });

  it("resolves the filtered runtime reader's identities in its explicit environment", async () => {
    await withOpenClawTestState({ scenario: "minimal", applyEnv: false }, async ({ env }) => {
      const profile = ensureProfileForEmail("scoped@example.test", { env });
      const scope = { agentId: "main", sessionKey: "agent:main:scoped", env };
      await replaceSessionEntry(scope, {
        sessionId: "scoped",
        updatedAt: Date.now(),
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      const runtime = createPluginRuntime();
      expect(
        runtime.agent.session
          .listSessionEntries({
            agentId: "main",
            env,
            readOnly: true,
            involvingProfileId: profile.id,
          })
          .map(({ sessionKey }) => sessionKey),
      ).toEqual([scope.sessionKey]);
      expect(
        runtime.agent.session.listSessionEntries({
          agentId: "main",
          env,
          readOnly: true,
          involvingProfileId: "",
        }),
      ).toEqual([]);
    });
  });

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
        { involvingProfileId: person.id },
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
