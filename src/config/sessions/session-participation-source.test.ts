import { expect, it } from "vitest";
import { captureSessionEntryView } from "./session-entry-view.js";
import {
  boundSessionParticipationSchema,
  captureSessionParticipationSource,
  captureSessionParticipationTarget,
  intersectSessionParticipationSources,
  matchesSessionParticipationSource,
  matchesSessionParticipationTarget,
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
