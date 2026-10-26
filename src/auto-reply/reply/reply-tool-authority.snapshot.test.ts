import { expect, it } from "vitest";
import { publishRetainedSessionEntryChange } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { retainReplyToolAuthorityClassification } from "./reply-tool-authority-cohort.js";

const creator = { type: "human", source: "profile", id: "creator" } satisfies NonNullable<
  SessionEntry["createdActor"]
>;
const actor = { ...creator, delegatedBy: { type: "agent", id: "parent" } } satisfies NonNullable<
  SessionEntry["createdActor"]
>;
const classificationEntry: SessionEntry = {
  sessionId: "classification",
  updatedAt: 1,
  lifecycleRevision: "generation",
  sandbox: "required",
  sandboxMode: "off",
  createdActor: actor,
};
function retain(entry: SessionEntry, assertCurrent = () => {}) {
  const key = `agent:main:${entry.sessionId}`;
  const databaseIdentity = `${entry.sessionId}-test`;
  const retained = retainReplyToolAuthorityClassification(
    {
      storePath: `/synthetic/${entry.sessionId}`,
      canonicalKey: key,
      storeKeys: [key],
      agentId: "main",
      source: { agentId: "main", path: `/synthetic/${entry.sessionId}.db`, databaseIdentity },
      sources: undefined,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    },
    entry,
    assertCurrent,
  );
  return {
    retained,
    publish: (patch: Partial<SessionEntry>) => {
      const next = { ...entry, ...patch };
      publishRetainedSessionEntryChange(databaseIdentity, key, next, entry, true, next);
    },
  };
}
it.each<[string, Partial<SessionEntry>, boolean]>([
  ["unrelated metadata", { updatedAt: 2, label: "Renamed" }, true],
  [
    "reordered actor keys",
    { createdActor: { delegatedBy: { id: "parent", type: "agent" }, ...creator } },
    true,
  ],
  ["session identity", { sessionId: "replacement" }, false],
  ["lifecycle", { lifecycleRevision: "replacement" }, false],
  ["sandbox requirement", { sandbox: undefined }, false],
  ["sandbox mode", { sandboxMode: undefined }, false],
  ["creator identity", { createdActor: { ...actor, id: "replacement" } }, false],
  ["nested creator identity", { createdActor: { ...actor, delegatedBy: creator } }, false],
  ["undefined actor property", { createdActor: { ...actor, label: undefined } }, false],
  ["removed creator", { createdActor: undefined }, false],
])("retained classification observes %s on publication", (_name, patch, current) => {
  const { retained, publish } = retain(classificationEntry);
  try {
    publish(patch);
    if (current) {
      expect(() => retained!.assertCurrent()).not.toThrow();
    } else {
      expect(() => retained!.assertCurrent()).toThrow("classification session changed");
    }
  } finally {
    retained?.release();
  }
});
it("treats absent and undefined classification fields equally but still checks live authority", () => {
  const entry: SessionEntry = { sessionId: "optional", updatedAt: 1 };
  let active = true;
  const { retained, publish } = retain(entry, () => {
    if (!active) {
      throw new Error("Caller revoked");
    }
  });
  try {
    publish({
      sandbox: undefined,
      sandboxMode: undefined,
      lifecycleRevision: undefined,
      createdActor: undefined,
    });
    expect(() => retained!.assertCurrent()).not.toThrow();
    active = false;
    expect(() => retained!.assertCurrent()).toThrow("Caller revoked");
    active = true;
    retained!.release();
    expect(() => retained!.assertCurrent()).toThrow("classification session changed");
  } finally {
    retained?.release();
  }
});
