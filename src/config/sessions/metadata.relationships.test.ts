import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import type { SessionEntry } from "./types.js";

function withRelationshipHints(ctx: MsgContext, hints: Record<string, unknown>): MsgContext {
  return {
    ...ctx,
    ...hints,
  };
}

describe("deriveSessionMetaPatch relationship hints", () => {
  it("accepts canonical lower-case relationship fields", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {
        Provider: "slack",
        From: "user:U1",
        entityRefs: ["entity:message:1", "entity:thread:1"],
        incidentId: "incident:123",
        threadEntityId: "entity:thread:1",
        repoRefs: ["repo:openclaw-sre"],
        artifactRefs: ["artifact:evidence:1"],
      },
      sessionKey: "agent:main:slack:user:u1",
    });

    expect(patch).toMatchObject({
      entityRefs: ["entity:message:1", "entity:thread:1"],
      incidentId: "incident:123",
      threadEntityId: "entity:thread:1",
      repoRefs: ["repo:openclaw-sre"],
      artifactRefs: ["artifact:evidence:1"],
    });
  });

  it("captures relationship fields from inbound context hints", () => {
    const patch = deriveSessionMetaPatch({
      ctx: withRelationshipHints(
        {
          Provider: "slack",
          From: "user:U1",
        },
        {
          EntityRefs: ["entity:message:1", "entity:thread:1", "entity:message:1", ""],
          IncidentId: "incident:123",
          ThreadEntityId: "entity:thread:1",
          RepoRefs: ["repo:openclaw-sre", "repo:morpho-infra-helm"],
          ArtifactRefs: ["artifact:evidence:1"],
        },
      ),
      sessionKey: "agent:main:slack:user:u1",
    });

    expect(patch).toMatchObject({
      entityRefs: ["entity:message:1", "entity:thread:1"],
      incidentId: "incident:123",
      threadEntityId: "entity:thread:1",
      repoRefs: ["repo:openclaw-sre", "repo:morpho-infra-helm"],
      artifactRefs: ["artifact:evidence:1"],
    });
  });

  it("merges ref arrays with existing metadata without clobbering prior refs", () => {
    const existing: SessionEntry = {
      sessionId: "sess-1",
      updatedAt: 1,
      entityRefs: ["entity:thread:1"],
      repoRefs: ["repo:openclaw-sre"],
      artifactRefs: ["artifact:bundle:1"],
      incidentId: "incident:existing",
    };

    const patch = deriveSessionMetaPatch({
      ctx: withRelationshipHints(
        {
          Provider: "slack",
          From: "user:U1",
        },
        {
          EntityRefs: ["entity:thread:1", "entity:message:2"],
          RepoRefs: ["repo:morpho-infra-helm"],
          ArtifactRefs: ["artifact:bundle:1", "artifact:evidence:2"],
        },
      ),
      sessionKey: "agent:main:slack:user:u1",
      existing,
    });

    expect(patch?.entityRefs).toEqual(["entity:thread:1", "entity:message:2"]);
    expect(patch?.repoRefs).toEqual(["repo:openclaw-sre", "repo:morpho-infra-helm"]);
    expect(patch?.artifactRefs).toEqual(["artifact:bundle:1", "artifact:evidence:2"]);
    expect(patch?.incidentId).toBeUndefined();
  });

  it("returns null when no relationship hints or other metadata are present", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {},
      sessionKey: "agent:main:slack",
    });

    expect(patch).toBeNull();
  });
});
