import { afterEach, expect, it } from "vitest";
import * as snapshots from "../../config/runtime-snapshot.js";
import { publishRetainedSessionEntryChange } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { retainReplyToolAuthorityClassification } from "./reply-tool-authority-cohort.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

const route = { provider: "openai", model: "test-model" };
const sender = { senderIsOwner: true, senderId: "alice", messageProvider: "telegram" };
const overlay = { ...sender, disableTools: false, traceAuthorized: false };
const authorities: Array<{ close(): void }> = [];
const run = { ...route, ...sender, sessionFile: "/tmp/s.json", workspaceDir: "/tmp/w" };
async function prepare(config: OpenClawConfig, sessionId: string) {
  let projected: OpenClawConfig | undefined;
  const authority = prepareReplyToolAuthority({ run: { ...run, config, sessionId } }, (input) => {
    projected = input.run.config;
    return input;
  });
  authorities.push(authority);
  const fingerprint = await authority.projectAsync(overlay, route);
  return { authority, fingerprint, config: projected! };
}
afterEach(() => {
  authorities.splice(0).forEach((authority) => authority.close());
  snapshots.clearRuntimeConfigSnapshot();
});
it("isolates unpublished configs from later edits", async () => {
  snapshots.setRuntimeConfigSnapshot({ tools: { deny: ["write"] } });
  const scoped: OpenClawConfig = { tools: { deny: ["exec"] } };
  const first = await prepare(scoped, "first");
  scoped.tools!.deny = ["read"];
  const next = await prepare(scoped, "next");
  expect(first.config.tools?.deny).toEqual(["exec"]);
  expect(next.config.tools?.deny).toEqual(["read"]);
  expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(first.authority.project(overlay, route)).toBe(first.fingerprint);
});

const classificationEntry: SessionEntry = {
  sessionId: "classification",
  updatedAt: 1,
  lifecycleRevision: "generation",
  sandbox: "required",
  sandboxMode: "off",
  createdActor: {
    type: "human",
    source: "profile",
    id: "creator",
    delegatedBy: { type: "agent", id: "parent" },
  },
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
    {
      createdActor: {
        delegatedBy: { id: "parent", type: "agent" },
        id: "creator",
        source: "profile",
        type: "human",
      },
    },
    true,
  ],
  ["session identity", { sessionId: "replacement" }, false],
  ["lifecycle", { lifecycleRevision: "replacement" }, false],
  ["sandbox requirement", { sandbox: undefined }, false],
  ["sandbox mode", { sandboxMode: undefined }, false],
  [
    "creator identity",
    { createdActor: { ...classificationEntry.createdActor!, id: "replacement" } },
    false,
  ],
  [
    "nested creator identity",
    {
      createdActor: {
        ...classificationEntry.createdActor!,
        delegatedBy: { type: "human", source: "profile", id: "creator" },
      },
    },
    false,
  ],
  [
    "explicit undefined actor property",
    { createdActor: { ...classificationEntry.createdActor!, label: undefined } },
    false,
  ],
  ["removed creator", { createdActor: undefined }, false],
])("retained classification observes %s on publication", (_name, patch, current) => {
  const { retained, publish } = retain(classificationEntry);
  expect(retained).toBeDefined();
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
