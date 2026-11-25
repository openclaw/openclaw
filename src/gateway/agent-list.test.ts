import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { getSqliteDatabaseAdmissionIdentityForPath } from "../infra/sqlite-database-admission.js";
import * as deletionFacts from "../state/agent-deletion-journal-status.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const list = (agents: OpenClawConfig["agents"]) => listGatewayAgentsBasic({ agents });

let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-agent-list-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});
afterEach(() => vi.unstubAllEnvs());
it("projects sole, Doctor-migrated, and ownerless fleet ownership honestly", async () => {
  const { config: migrated } = createCanonicalAgentConfigFixture({
    agents: { entries: { first: {}, retired: { default: true }, research: {} } },
  });
  const fleet = { ownership: "explicit", entries: { ops: {}, research: {} } } as const;
  for (const [agents, expected] of [
    [{ entries: { ops: {} } }, ["ops", "sole", false]],
    [migrated.agents, ["retired", "explicit", false]],
    [fleet, ["ops", "explicit", true]],
    [
      { ...fleet, defaults: { systemAgent: { agentId: "research" } } },
      ["research", "explicit", false],
    ],
  ] as const) {
    const { defaultId, ownership, selectionRequired } = await list(agents);
    expect([defaultId, ownership, selectionRequired]).toEqual(expected);
  }
});

it("retains disk system agents without treating regular disk dirs as roster members", async () => {
  for (const id of ["openclaw", "crestodian", "research"]) {
    await fs.mkdir(path.join(stateDir, "agents", id), { recursive: true });
  }
  using syncRead = vi.spyOn(fsSync, "readdirSync").mockImplementation(() => {
    throw new Error("Roster inventory must not block the Gateway thread");
  });
  const cfg = { agents: { entries: { main: {} } } };
  const result = await listGatewayAgentsBasic(cfg);

  expect(result.agents).toEqual([
    { id: "main", kind: "agent", name: undefined },
    { id: "crestodian", kind: "system", name: undefined },
    { id: "openclaw", kind: "system", name: undefined },
  ]);
  await fs.rmdir(path.join(stateDir, "agents", "crestodian"));
  const remaining = await listGatewayAgentsBasic(cfg);
  expect(remaining.agents.map(({ id }) => id)).toEqual(["main", "openclaw"]);
  expect(syncRead).not.toHaveBeenCalled();
});

it.each([
  { name: "OpenClaw", identity: "Fallback", expected: "OpenClaw" },
  { name: undefined, identity: "小金", expected: "小金" },
])(
  "projects configured disk agents with display name $expected",
  async ({ name, identity, expected }) => {
    await fs.mkdir(path.join(stateDir, "agents", "openclaw"), { recursive: true });
    const result = await list({
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, openclaw: { name, identity: { name: identity } } },
    });
    expect(result.agents).toEqual([
      { id: "main", kind: "agent", name: undefined },
      { id: "openclaw", kind: "agent", name: expected },
    ]);
  },
);

it("lists cold deletion state without filesystem work in optional receipt lookup", async () => {
  expect(isMainThread).toBe(true);
  const cfg = { agents: { entries: { main: {}, retired: {} } } };
  const original = resolveOpenClawStateSqlitePath();
  using reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const readCount = () =>
    reads.mock.calls.filter(([, command]) => command.type === "agentDatabaseDeletion.snapshot")
      .length;
  const listWithReceipt = async (expectedReads: number) => {
    const beforeReads = readCount();
    using filesystem = observeMainThreadFs();
    const read = deletionFacts.getPreparedAgentDeletionDiscovery;
    let getterFilesystemCalls = 0;
    using observed = vi
      .spyOn(deletionFacts, "getPreparedAgentDeletionDiscovery")
      .mockImplementation((...args) => {
        const before = filesystem.count();
        try {
          return read(...args);
        } finally {
          getterFilesystemCalls += filesystem.count() - before;
        }
      });
    const result = await listGatewayAgentsBasic(cfg);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(getterFilesystemCalls).toBe(0);
    expect(readCount() - beforeReads).toBe(expectedReads);
    return result;
  };
  try {
    expect(getSqliteDatabaseAdmissionIdentityForPath(original)).toBeUndefined();
    expect((await listWithReceipt(1)).agents.map(({ id }) => id)).toEqual(["main", "retired"]);
    expect((await listWithReceipt(1)).agents.map(({ id }) => id)).toEqual(["main", "retired"]);
    expect(fsSync.existsSync(original)).toBe(false);

    beginAgentDeletionJournal({
      agentId: "retired",
      operationId: "probe-delete-retired",
      agentDir: path.join(stateDir, "agents", "retired", "agent"),
      workspaceDir: path.join(stateDir, "workspace"),
      sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
      deleteFiles: false,
    });
    expect((await listWithReceipt(0)).agents.map(({ id }) => id)).toEqual(["main"]);

    await closeOpenClawStateDatabaseAsync();
    const copiedState = tempDirs.make("openclaw-agent-list-cold-copy-");
    const copied = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: copiedState });
    await fs.mkdir(path.dirname(copied), { recursive: true });
    await fs.copyFile(original, copied);
    vi.stubEnv("OPENCLAW_STATE_DIR", copiedState);
    expect(getSqliteDatabaseAdmissionIdentityForPath(copied)).toBeUndefined();
    expect((await listWithReceipt(1)).agents.map(({ id }) => id)).toEqual(["main"]);
    expect((await listWithReceipt(0)).agents.map(({ id }) => id)).toEqual(["main"]);
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
});
