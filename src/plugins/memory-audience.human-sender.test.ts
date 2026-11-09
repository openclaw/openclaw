import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "../agents/operational-run-instance.js";

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } = await import("./memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
// mock-isolation: the fake session owner replaces worker-thread session reads.
vi.mock("../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } = await import("./memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});

import { resolveMemoryAudienceFromEntry } from "./memory-audience.js";
import { fakeSessionOwner, type FakeSessionRow } from "./memory-audience.test-support.js";
import { type HumanSenderTurn, issueHumanSenderTurn } from "./memory-human-sender-turn.js";

const AGENT_ID = "main";
const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const STORE_PATH = "/tmp/openclaw-memory-audience-human/main.sqlite";

function row(fields: Partial<FakeSessionRow> = {}): FakeSessionRow {
  return { sessionId: randomUUID(), lifecycleRevision: randomUUID(), updatedAt: 1, ...fields };
}

// An owner-spawned child whose root owner chat was reset after the spawn.
function staleChild(fields: Partial<FakeSessionRow> = {}) {
  const root = row({ chatType: "direct" });
  const child = row({
    spawnedBy: ROOT_KEY,
    parentSessionKey: ROOT_KEY,
    spawnedBySessionId: root.sessionId,
    parentSessionLifecycleRevision: root.lifecycleRevision,
    spawnedBySenderIsOwner: true,
    ...fields,
  });
  fakeSessionOwner.rows.set(ROOT_KEY, { ...root, lifecycleRevision: randomUUID() });
  fakeSessionOwner.rows.set(CHILD_KEY, child);
  return child;
}

function boundTurn(senderIsOwner: boolean, sessionKey = CHILD_KEY) {
  const run = createOperationalRunInstanceRef(randomUUID());
  const turn = issueHumanSenderTurn({ sessionKey, senderIsOwner });
  turn.bind({ operationalRunInstance: run });
  return { turn, run };
}

function resolveChild(
  child: FakeSessionRow,
  params: {
    senderIsOwner?: boolean;
    humanSenderTurn?: HumanSenderTurn;
    operationalRunInstance?: OperationalRunInstanceRef;
    scheduledParent?: Parameters<typeof resolveMemoryAudienceFromEntry>[0]["scheduledParent"];
  },
) {
  return resolveMemoryAudienceFromEntry(
    {
      agentId: AGENT_ID,
      sessionKey: CHILD_KEY,
      sessionId: child.sessionId,
      senderIsOwner: params.senderIsOwner,
      storePath: STORE_PATH,
      humanSenderTurn: params.humanSenderTurn,
      operationalRunInstance: params.operationalRunInstance,
      scheduledParent: params.scheduledParent,
    },
    child,
  );
}

beforeEach(() => fakeSessionOwner.reset());

it.each([
  ["stale ancestor", {}],
  ["sidebar-root promotion", { sidebarRoot: true }],
  ["legacy receipt", { spawnedBySenderIsOwner: undefined }],
])("grants an owner's typed turn its own private audience after %s", async (_name, fields) => {
  const child = staleChild(fields);
  const { turn, run } = boundTurn(true);
  const resolution = await resolveChild(child, {
    senderIsOwner: true,
    humanSenderTurn: turn,
    operationalRunInstance: run,
  });
  expect(resolution).toMatchObject({
    status: "granted",
    audience: { kind: "owner-private", agentId: AGENT_ID },
  });
  // Nothing is inherited: only the typed-into session is leased, no ancestor is read.
  expect(fakeSessionOwner.workerReads).toEqual([]);
  expect(fakeSessionOwner.activeLeases).toBe(1);
  if (resolution.status === "granted") {
    resolution.release();
  }
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it.each([
  ["non-owner operator", false, true],
  ["non-owner run sender", true, false],
])("denies a %s typing into a spawned session", async (_name, attested, runOwner) => {
  // A current owner lineage must not upgrade a non-owner human either.
  const root = row({ chatType: "direct" });
  fakeSessionOwner.rows.set(ROOT_KEY, root);
  const child = row({
    spawnedBy: ROOT_KEY,
    parentSessionKey: ROOT_KEY,
    spawnedBySessionId: root.sessionId,
    parentSessionLifecycleRevision: root.lifecycleRevision,
    spawnedBySenderIsOwner: true,
  });
  fakeSessionOwner.rows.set(CHILD_KEY, child);
  const { turn, run } = boundTurn(attested);
  await expect(
    resolveChild(child, {
      senderIsOwner: runOwner,
      humanSenderTurn: turn,
      operationalRunInstance: run,
    }),
  ).resolves.toMatchObject({ status: "denied", kind: "ineligible" });
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("keeps lineage rules for turns without a human sender", async () => {
  const unbound = issueHumanSenderTurn({ sessionKey: CHILD_KEY, senderIsOwner: true });
  const other = boundTurn(true);
  const forRoot = boundTurn(true, ROOT_KEY);
  const forged = { bind() {}, senderIsOwner: true, sessionKey: CHILD_KEY } as HumanSenderTurn;
  const cases = [
    // Subagent, cron, sessions_send, announce and heartbeat runs carry no turn.
    {},
    // Copied metadata or a model-authored object is not a host-issued turn.
    { humanSenderTurn: forged, operationalRunInstance: other.run },
    // An issued turn that its run never admitted.
    { humanSenderTurn: unbound, operationalRunInstance: other.run },
    // A copy of the turn executed by another run (followup, retry, maintenance).
    {
      humanSenderTurn: other.turn,
      operationalRunInstance: createOperationalRunInstanceRef(randomUUID()),
    },
    // A turn issued for another session.
    { humanSenderTurn: forRoot.turn, operationalRunInstance: forRoot.run },
  ];
  for (const humanSender of cases) {
    const child = staleChild();
    await expect(
      resolveChild(child, { senderIsOwner: true, ...humanSender }),
    ).resolves.toMatchObject({ status: "denied", kind: "stale-lineage" });
  }
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it("keeps the scheduled owner cap when a scheduled run carries a human turn", async () => {
  const child = staleChild();
  const { turn, run } = boundTurn(true);
  await expect(
    resolveChild(child, {
      senderIsOwner: true,
      humanSenderTurn: turn,
      operationalRunInstance: run,
      scheduledParent: {
        sessionKey: CHILD_KEY,
        sessionId: child.sessionId,
        lifecycleRevision: child.lifecycleRevision,
        senderIsOwner: false,
      },
    }),
  ).resolves.toMatchObject({ status: "denied", kind: "stale-lineage" });
});

it("keeps lineage rules for an owner typing into a spawned shared room", async () => {
  const child = staleChild({ chatType: "group" });
  const { turn, run } = boundTurn(true);
  await expect(
    resolveChild(child, {
      senderIsOwner: true,
      humanSenderTurn: turn,
      operationalRunInstance: run,
    }),
  ).resolves.toMatchObject({ status: "denied", kind: "stale-lineage" });
});
