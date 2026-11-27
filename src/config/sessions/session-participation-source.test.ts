import { expect, it } from "vitest";
import { captureSessionEntryView } from "./session-entry-view.js";
import {
  boundSessionParticipationSchema,
  captureSessionParticipationSource,
  captureSessionParticipationTarget,
  intersectSessionParticipationSources,
  matchesSessionParticipationRevocation,
  matchesSessionParticipationSource,
  matchesSessionParticipationTarget,
  retainSessionParticipation,
  publishSessionParticipationMemberChange,
} from "./session-participation-source.js";
import type { SessionEntry } from "./types.js";

it("captures and restores one immutable original invitation, never a successor", () => {
  const target = {
    agentId: "main",
    canonicalKey: "agent:main:invited",
    entry: {
      sessionId: "original",
      lifecycleRevision: "revision",
      createdActor: { type: "human", source: "profile", id: "creator" },
      sessionRoot: "/invited",
    } satisfies Partial<SessionEntry>,
  };
  const source = captureSessionParticipationSource(target.canonicalKey, target, "/fallback");
  const ceiling = {
    kind: "send",
    profileId: "participant",
    sessionKey: target.canonicalKey,
    tools: ["read"],
    permission: "guarded",
    source,
  };
  const stored = JSON.stringify(ceiling);
  const restored = boundSessionParticipationSchema.parse(JSON.parse(stored));
  expect(JSON.stringify(restored)).toBe(stored);
  expect(Object.isFrozen(source)).toBe(true);
  expect(matchesSessionParticipationSource(restored, target, "/different-fallback")).toBe(true);
  expect(intersectSessionParticipationSources(source, restored.source)).toEqual(source);
  for (const change of [
    { agentId: "other" },
    { sessionId: "successor" },
    { lifecycleRevision: "successor" },
    { creatorProfileId: "successor" },
    { root: "/outside" },
  ]) {
    const substituted = { ...restored.source, ...change };
    expect(() => intersectSessionParticipationSources(source, substituted)).toThrow(
      "one original invitation",
    );
    expect(
      matchesSessionParticipationSource({ ...restored, source: substituted }, target, "/fallback"),
    ).toBe(false);
  }
  const selected = captureSessionParticipationTarget(target);
  target.entry.sessionId = "successor";
  expect(source.sessionId).toBe("original");
  expect(
    matchesSessionParticipationTarget(selected, captureSessionParticipationTarget(target)),
  ).toBe(false);
  expect(matchesSessionParticipationSource(restored, target, "/fallback")).toBe(false);
});

it("retires only exact committed invitation producers and never revives retained custody", () => {
  const target = {
    profileId: "person",
    agentId: "main",
    sessionKey: "agent:main:invited",
    sessionId: "original",
  };
  const lifetime = retainSessionParticipation(target);
  try {
    target.sessionId = "caller-mutation";
    publishSessionParticipationMemberChange(target.agentId, target.sessionKey, {
      sessionId: target.sessionId,
      identityId: target.profileId,
      present: false,
    });
    expect(lifetime.signal.aborted).toBe(false);
    lifetime.followIncarnation("original", "admitted");
    const committed = { ...target, sessionId: "admitted" };
    const invitation = {
      ...committed,
      source: {
        agentId: "main",
        sessionId: "admitted",
        lifecycleRevision: null,
        creatorProfileId: "creator",
        root: "/invited",
      },
    };
    expect(matchesSessionParticipationRevocation(invitation, committed)).toBe(true);
    expect(
      matchesSessionParticipationRevocation(invitation, { ...committed, sessionId: "original" }),
    ).toBe(false);
    publishSessionParticipationMemberChange(committed.agentId, committed.sessionKey, {
      sessionId: committed.sessionId,
      identityId: "unrelated",
      present: false,
    });
    expect(lifetime.signal.aborted).toBe(false);
    publishSessionParticipationMemberChange(committed.agentId, committed.sessionKey, {
      sessionId: committed.sessionId,
      identityId: committed.profileId,
      present: false,
    });
    expect(lifetime.signal.aborted).toBe(true);
    lifetime.followIncarnation("admitted", "reinvited");
    expect(lifetime.signal.aborted).toBe(true);
    const renewed = retainSessionParticipation(committed);
    expect(renewed.signal.aborted).toBe(false);
    renewed.release();
  } finally {
    lifetime.release();
  }
});

it("owns detached read preconditions without retaining mutable caller metadata", () => {
  const entry: SessionEntry = {
    sessionId: "original",
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "creator" },
  };
  const view = captureSessionEntryView(entry, ["sessionId", "lifecycleRevision", "createdActor"]);
  expect(view.matches({ ...entry, updatedAt: 2 })).toBe(true);
  expect(view.matches({ ...entry, lifecycleRevision: null })).toBe(true);
  expect(view.matches({ ...entry, sessionId: "successor" })).toBe(false);
  expect(view.matches({ ...entry, lifecycleRevision: "successor" })).toBe(false);
  entry.createdActor!.id = "different";
  expect(view.matches(entry)).toBe(false);
});
