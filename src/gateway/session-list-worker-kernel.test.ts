import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import { createSessionListWorkerKernel } from "./session-list-worker-kernel.js";
import type {
  SessionListWorkerRequest,
  SessionListWorkerRow,
} from "./session-list-worker.types.js";

function row(
  key: string,
  entry: Partial<SessionEntry> = {},
  agentId = "main",
): SessionListWorkerRow {
  const value = { sessionId: key, updatedAt: 1, ...entry };
  return {
    key,
    agentId,
    storeTarget: { agentId, storePath: `/${agentId}/sessions` },
    entry: value,
    selection: readSessionListSelectionFacts(key, value),
  };
}

function request(overrides: Partial<SessionListWorkerRequest> = {}): SessionListWorkerRequest {
  return {
    opts: {},
    now: 100_000,
    scopeId: "all",
    scope: {
      paths: new Map([
        ["/main/sessions", 0],
        ["/other/sessions", 1],
      ]),
      path: "(multiple)",
      ownerAgentIds: new Set(["main", "other"]),
      configuredAgentIds: undefined,
      agentId: undefined,
    },
    visibility: { kind: "all" },
    restrictProfileReferences: false,
    projectActiveRun: false,
    activeRuns: new Map(),
    ...overrides,
  };
}

const physicalId = (value: SessionListWorkerRow) =>
  `${value.agentId}\0${value.storeTarget.storePath}\0${value.key}`;

describe("session list worker selection", () => {
  it("keeps ordered pages and totals current after cloned exact updates and deletion", () => {
    const kernel = createSessionListWorkerKernel();
    const first = row("agent:main:first", { updatedAt: 3 });
    const second = row("agent:main:second", { updatedAt: 2 });
    kernel.apply(structuredClone({ cfg: {}, reset: [first, second] }));
    expect(kernel.select(request({ opts: { limit: 1 } }))).toMatchObject({
      keys: [first.key],
      selection: { totalCount: 2, nextOffset: 1, hasMore: true },
    });
    const updated = row(second.key, { updatedAt: 4 });
    kernel.apply(
      structuredClone({ changes: [{ id: physicalId(updated), ...updated, row: updated }] }),
    );
    expect(kernel.select(request({ opts: { limit: 1 } })).keys).toEqual([second.key]);
    kernel.apply({
      changes: [{ id: physicalId(second), key: second.key, agentId: "main", row: undefined }],
    });
    expect(kernel.select(request())).toMatchObject({
      keys: [first.key],
      selection: { totalCount: 1, nextOffset: null, hasMore: false },
    });
  });

  it("applies viewer aliases before people and count facets, then rechecks each request", () => {
    const own = row("agent:main:own", {
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: "old-person" },
    });
    const foreign = row("agent:main:foreign", {
      updatedAt: 2,
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: "foreign-person" },
    });
    const kernel = createSessionListWorkerKernel();
    kernel.apply(
      structuredClone({
        cfg: {},
        reset: [own, foreign],
        profiles: new Map([
          [
            "old-person",
            { id: "person", displayName: "Owner", hasAvatar: false, avatarRevision: "1" },
          ],
          ["person", { id: "person", displayName: "Owner", hasAvatar: false, avatarRevision: "1" }],
          [
            "foreign-person",
            { id: "foreign-person", displayName: "Foreign", hasAvatar: false, avatarRevision: "1" },
          ],
        ]),
      }),
    );
    const query = request({
      opts: { includePeople: true, includeOwnerSessionCounts: true },
      visibility: {
        kind: "profile",
        profileId: "person",
        aliases: new Set(["old-person"]),
        sessionCap: "none",
      },
      restrictProfileReferences: true,
    });
    expect(kernel.select(structuredClone(query))).toMatchObject({
      keys: [own.key],
      selection: { totalCount: 1, people: [{ identity: { id: "person" }, sessionCount: 1 }] },
    });
    expect(kernel.select({ ...query, visibility: { kind: "none" } })).toMatchObject({
      keys: [],
      selection: { totalCount: 0, people: [], ownerSessionCounts: [] },
    });
  });

  it("federates sentinels before visibility, while active pages preserve each agent", () => {
    const main = row("global", { visibility: "draft" });
    const other = row("global", { visibility: "shared" }, "other");
    const kernel = createSessionListWorkerKernel();
    kernel.apply(structuredClone({ cfg: {}, reset: [main, other] }));
    const viewer = request({
      opts: { includeGlobal: true },
      visibility: { kind: "profile", profileId: "reader", aliases: new Set() },
    });
    expect(kernel.select(viewer).keys).toEqual([]);
    expect(
      kernel.select({
        ...viewer,
        opts: { includeGlobal: true, activeOnly: true },
        projectActiveRun: true,
        activeRuns: new Map([[physicalId(other), { active: true }]]),
      }),
    ).toMatchObject({
      keys: [JSON.stringify(["global", "other"])],
      queries: [{ key: "global", agentId: "other", storePath: "/other/sessions" }],
    });
  });

  it("keeps exact reads independent of unrelated duplicate keys and ages activity windows", () => {
    const target = row("agent:main:target", { updatedAt: 50_000 });
    const duplicate = row("agent:main:duplicate");
    const conflicting = {
      ...duplicate,
      storeTarget: { agentId: "other", storePath: "/other/sessions" },
    };
    const kernel = createSessionListWorkerKernel();
    kernel.apply(structuredClone({ cfg: {}, reset: [target, duplicate, conflicting] }));
    const query = request({ key: target.key, opts: { activeMinutes: 1 } });
    expect(kernel.select(query).keys).toEqual([target.key]);
    expect(kernel.select({ ...query, now: 110_001 }).keys).toEqual([]);
    kernel.apply({ reset: [target] });
    const page = { ...query, key: undefined };
    expect(kernel.select(page).keys).toEqual([target.key]);
    expect(kernel.select({ ...page, now: 110_001 }).keys).toEqual([]);
  });

  it("expires child ownership when a person filter requires the full roster", () => {
    const child = row("agent:main:subagent:child", {
      updatedAt: 50_000,
      spawnedBy: "agent:main:parent",
      createdActor: { type: "human", source: "profile", id: "person" },
    });
    const kernel = createSessionListWorkerKernel();
    kernel.apply({
      cfg: {},
      reset: [child],
      profiles: new Map([
        ["person", { id: "person", displayName: "Owner", hasAvatar: false, avatarRevision: "1" }],
      ]),
    });
    const query = request({
      opts: { involvingProfileId: "person", spawnedBy: "agent:main:parent" },
    });
    expect(kernel.select(query).keys).toEqual([child.key]);
    expect(kernel.select({ ...query, now: 3_650_001 }).keys).toEqual([]);
  });

  it("searches host-prepared model identities without reconstructing plugin registries", () => {
    const target = row("agent:main:custom");
    const kernel = createSessionListWorkerKernel();
    kernel.apply(structuredClone({ cfg: {}, reset: [target] }));
    const query = request({
      opts: { search: "configured-model" },
      searchRows: new Map([
        [
          physicalId(target),
          {
            modelIdentity: { provider: "example", model: "configured-model" },
            modelFacts: {
              selectedModel: {
                provider: "example",
                model: "configured-model",
                storedOverrideSource: null,
              },
              rowModelIdentity: { provider: "example", model: "configured-model" },
              thinkingProjection: {
                acpMeta: undefined,
                agentRuntime: { id: "openclaw", source: "session" },
              },
            },
          },
        ],
      ]),
    });
    expect(kernel.select(structuredClone(query)).keys).toEqual([target.key]);
    expect(kernel.select({ ...query, opts: { search: "agent:configured-model" } }).keys).toEqual(
      [],
    );
  });
});
