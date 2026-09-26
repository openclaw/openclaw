import { expect, it } from "vitest";
import { createSubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SessionEntry } from "../config/sessions.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import { filterSessionEntries } from "./session-list-filters.js";
import type { SessionEntryPair } from "./session-list-order.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";

it("benchmarks warm identity filtering across viewers", () => {
  const cfg = { agents: { list: [{ id: "main", default: true }] } };
  const context = createSessionRowProjectionContext(
    createSubagentSessionListReadView({ env: process.env }),
  ).current;
  const identities = context.userProfileIdentityById;
  for (let index = 0; index < 50; index++) {
    const id = `profile-${index}`;
    identities.set(id, {
      kind: "resolved",
      profileId: id,
      label: `Viewer ${index}`,
      avatarUrl: `/avatar/${id}`,
      hasUploadedAvatar: true,
    });
  }
  const entries: SessionEntryPair[] = Array.from({ length: 4_428 }, (_, index) => {
    const entry: SessionEntry = {
      sessionId: `session-${index}`,
      updatedAt: index + 1,
      createdActor: { type: "human", source: "profile", id: `profile-${index % 50}` },
      participants: Array.from({ length: 3 }, (_participant, offset) => ({
        identity: { type: "profile", id: `profile-${(index + offset) % 50}` },
      })),
      ...(index >= 2_300 ? { archivedAt: 1 } : {}),
    };
    return [`agent:main:session-${index}`, entry];
  });
  const targets = new Map(
    entries.map(([key, entry]) => [
      key,
      { agentId: "main", selection: readSessionListSelectionFacts(key, entry) },
    ]),
  );
  const configuredAgentIds = new Set(["main"]);
  for (const involving of [false, true]) {
    const samples: number[] = [];
    for (let index = 0; index < 70; index++) {
      const started = process.threadCpuUsage();
      const result = runSynchronousWork(
        filterSessionEntries({
          cfg,
          entries,
          getTarget: (key) => targets.get(key),
          getRowContext: () => context,
          userProfileIdentityById: identities,
          configuredAgentIds,
          now: 5_000,
          opts: {},
          involvingActorId: involving ? `profile-${index % 50}` : undefined,
        }),
      );
      const elapsed = process.threadCpuUsage(started);
      if (index >= 20) {
        samples.push((elapsed.user + elapsed.system) / 1_000);
      }
      expect(result.entries).toHaveLength(involving ? 138 : 2_300);
      expect(result.ownerFacet).toHaveLength(50);
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        rows: entries.length,
        liveRows: 2_300,
        viewers: 50,
        involving,
        samples: samples.length,
        p50ThreadCpuMs: samples[Math.floor(samples.length / 2)],
      }),
    );
  }
});
