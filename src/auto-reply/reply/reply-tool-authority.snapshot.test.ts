import { afterEach, expect, it } from "vitest";
import { withPreparedToolConstruction } from "../../agents/tool-construction-preparation.js";
import * as facts from "../../config/resolution-facts.js";
import * as snapshots from "../../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
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
it("pins active turns across policy publication and reset", async () => {
  const config: OpenClawConfig = { tools: { deny: ["exec"] } };
  snapshots.setRuntimeConfigSnapshot(config);
  const first = await prepare(config, "first");
  const second = await prepare(config, "second");
  expect(second.config).toBe(first.config);
  expect(second.config).toBe(captureRuntimeConfig(config));
  expect(Object.isFrozen(first.config.tools?.deny)).toBe(true);
  expect(() => first.config.tools!.deny!.push("read")).toThrow(TypeError);
  config.tools!.deny = ["read"];
  snapshots.setRuntimeConfigSnapshot(config);
  const next = await prepare(config, "next");
  expect(next.config).not.toBe(first.config);
  expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(first.authority.project(overlay, route)).toBe(first.fingerprint);
  expect(first.config.tools?.deny).toEqual(["exec"]);
  snapshots.clearRuntimeConfigSnapshot();
  snapshots.setRuntimeConfigSnapshot(config);
  expect((await prepare(config, "after-reset")).config).not.toBe(next.config);
});
it.each(["mutable", "captured", "republished", "async-republished"] as const)(
  "pins provenance when publishing a %s config",
  async (input) => {
    const policy: OpenClawConfig = { tools: { deny: ["exec"] } };
    const config = input === "captured" ? captureRuntimeConfig(policy) : policy;
    snapshots.setRuntimeConfigSnapshot(config);
    const first = await prepare(snapshots.getRuntimeConfigSnapshot()!, "first");
    const toolConfig = await withPreparedToolConstruction(
      snapshots.getRuntimeConfigSnapshot()!,
      { env: { HOME: "/tmp/synthetic-home", OPENCLAW_STATE_DIR: "/tmp/synthetic-state" } },
      (prepared) => prepared.config,
    );
    expect(toolConfig).toBe(first.config);
    if (input === "republished") {
      snapshots.setRuntimeConfigSnapshot(first.config);
    } else if (input === "async-republished") {
      snapshots.clearRuntimeConfigSnapshot();
      await snapshots.loadPinnedRuntimeConfigAsync(async () => ({ config: first.config }));
    }
    const source = structuredClone(config);
    const resolution = facts.createConfigResolutionFacts(
      [],
      new Map([["gateway.auth.token", "TOKEN"]]),
    );
    facts.setConfigResolutionFacts(source, resolution);
    expect(
      snapshots.setRuntimeConfigSourceSnapshotIfCurrent({
        expectedRevision: snapshots.getRuntimeConfigSnapshotMetadata()!.revision,
        sourceConfig: source,
      }),
    ).toBe(true);
    const next = await prepare(snapshots.getRuntimeConfigSnapshot()!, "next");
    expect(next.config).not.toBe(first.config);
    expect(facts.getConfigResolutionFacts(next.config)).toBe(resolution);
    expect(facts.getConfigResolutionFacts(first.config)).toBeNull();
    expect(facts.getConfigResolutionFacts(toolConfig)).toBeNull();
  },
);
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
it.each([
  { name: "unrelated metadata", patch: { updatedAt: 2, label: "Renamed" }, current: true },
  {
    name: "reordered actor keys",
    patch: {
      createdActor: {
        delegatedBy: { id: "parent", type: "agent" },
        id: "creator",
        source: "profile",
        type: "human",
      },
    },
    current: true,
  },
  { name: "session identity", patch: { sessionId: "replacement" }, current: false },
  { name: "lifecycle", patch: { lifecycleRevision: "replacement" }, current: false },
  { name: "sandbox requirement", patch: { sandbox: undefined }, current: false },
  { name: "sandbox mode", patch: { sandboxMode: undefined }, current: false },
  {
    name: "creator identity",
    patch: { createdActor: { ...classificationEntry.createdActor!, id: "replacement" } },
    current: false,
  },
  {
    name: "nested creator identity",
    patch: {
      createdActor: {
        ...classificationEntry.createdActor!,
        delegatedBy: { type: "human", source: "profile", id: "creator" },
      },
    },
    current: false,
  },
  {
    name: "explicit undefined actor property",
    patch: { createdActor: { ...classificationEntry.createdActor!, label: undefined } },
    current: false,
  },
  { name: "removed creator", patch: { createdActor: undefined }, current: false },
] satisfies { name: string; patch: Partial<SessionEntry>; current: boolean }[])(
  "retained classification observes $name on publication",
  ({ patch, current }) => {
    const original = {
      storePath: "/synthetic/classification",
      canonicalKey: "agent:main:classification",
      storeKeys: ["agent:main:classification"],
      agentId: "main",
      source: {
        agentId: "main",
        path: "/synthetic/classification.db",
        databaseIdentity: "classification-test",
      },
      sources: undefined,
      sessionId: classificationEntry.sessionId,
      lifecycleRevision: classificationEntry.lifecycleRevision,
    };
    const retained = retainReplyToolAuthorityClassification(
      original,
      classificationEntry,
      () => {},
    );
    expect(retained).toBeDefined();
    try {
      const entry = { ...classificationEntry, ...patch };
      publishRetainedSessionEntryChange(
        "classification-test",
        original.canonicalKey,
        entry,
        classificationEntry,
        true,
        entry,
      );
      if (current) {
        expect(() => retained!.assertCurrent()).not.toThrow();
      } else {
        expect(() => retained!.assertCurrent()).toThrow("classification session changed");
      }
    } finally {
      retained?.release();
    }
  },
);
it("treats absent and undefined classification fields equally but still checks live authority", () => {
  const entry: SessionEntry = { sessionId: "optional", updatedAt: 1 };
  let active = true;
  const original = {
    storePath: "/synthetic/optional",
    canonicalKey: "agent:main:optional",
    storeKeys: ["agent:main:optional"],
    agentId: "main",
    source: { agentId: "main", path: "/synthetic/optional.db", databaseIdentity: "optional-test" },
    sources: undefined,
    sessionId: entry.sessionId,
    lifecycleRevision: undefined,
  };
  const retained = retainReplyToolAuthorityClassification(original, entry, () => {
    if (!active) {
      throw new Error("Caller revoked");
    }
  });
  try {
    const next = {
      ...entry,
      sandbox: undefined,
      sandboxMode: undefined,
      lifecycleRevision: undefined,
      createdActor: undefined,
    };
    publishRetainedSessionEntryChange(
      "optional-test",
      original.canonicalKey,
      next,
      entry,
      true,
      next,
    );
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
