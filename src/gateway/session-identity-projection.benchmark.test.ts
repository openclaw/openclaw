import { expect, it, onTestFinished } from "vitest";
import { createSubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SessionEntry } from "../config/sessions.js";
import { filterSessionEntries } from "./session-list-filters.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import { createSessionRowSelection } from "./session-row-selection.js";

it("benchmarks warm identity filtering across viewers", () => {
  const cfg = { agents: { entries: { main: {} } } };
  const owner = createSessionRowProjectionContext(
    createSubagentSessionListReadView({ env: process.env }),
  );
  onTestFinished(owner.dispose);
  const context = owner.current;
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
  const configuredAgentIds = new Set(["main"]);
  const storePath = "/tmp/identity-selection-benchmark";
  const selection = createSessionRowSelection(
    cfg,
    {
      path: storePath,
      paths: new Map([[storePath, 0]]),
      agentId: "main",
      configuredAgentIds,
      ownerAgentIds: configuredAgentIds,
    },
    false,
    () => context,
  );
  const rows = 4_428;
  for (let index = 0; index < rows; index++) {
    const key = `agent:main:session-${index}`;
    const entry: SessionEntry = {
      sessionId: `session-${index}`,
      updatedAt: index + 1,
      createdActor: { type: "human", source: "profile", id: `profile-${index % 50}` },
      participants: Array.from({ length: 3 }, (_, offset) => ({
        identity: { type: "profile", id: `profile-${(index + offset) % 50}` },
      })),
      ...(index >= 2_300 ? { archivedAt: 1 } : {}),
    };
    selection.add({
      key,
      entry,
      agentId: "main",
      storeTarget: { agentId: "main", storePath },
      selection: readSessionListSelectionFacts(key, entry),
      generation: Symbol(key),
      hasBoard: false,
    });
  }
  const selected = selection.read();
  for (const involving of [false, true]) {
    const samples: number[] = [];
    for (let index = 0; index < 70; index++) {
      const started = process.threadCpuUsage();
      const result = filterSessionEntries({
        cfg,
        entries: selected.entries,
        getTarget: selected.get,
        involvementKeys: selected.involvementKeys,
        getRowContext: () => context,
        userProfileIdentityById: identities,
        configuredAgentIds,
        now: 5_000,
        opts: {},
        involvingActorId: involving ? `profile-${index % 50}` : undefined,
      });
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
        rows,
        liveRows: 2_300,
        viewers: 50,
        involving,
        samples: samples.length,
        p50ThreadCpuMs: samples[Math.floor(samples.length / 2)],
      }),
    );
  }
});
