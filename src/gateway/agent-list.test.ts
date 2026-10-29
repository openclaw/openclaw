import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
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
