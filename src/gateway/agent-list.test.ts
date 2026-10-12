/**
 * Gateway agent-list RPC regression tests.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("listGatewayAgentsBasic", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-agent-list-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("projects sole, Doctor-migrated, and ownerless fleet ownership honestly", async () => {
    expect(await listGatewayAgentsBasic({ agents: { entries: { ops: {} } } })).toMatchObject({
      defaultId: "ops",
      ownership: "sole",
      selectionRequired: false,
    });

    const { config: migrated } = createCanonicalAgentConfigFixture({
      agents: { entries: { first: {}, retired: { default: true }, research: {} } },
    });
    expect(await listGatewayAgentsBasic(migrated)).toMatchObject({
      defaultId: "retired",
      ownership: "explicit",
      selectionRequired: false,
    });

    expect(
      await listGatewayAgentsBasic({
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      }),
    ).toMatchObject({
      defaultId: "ops",
      ownership: "explicit",
      selectionRequired: true,
    });

    expect(
      await listGatewayAgentsBasic({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "research" } },
          entries: { ops: {}, research: {} },
        },
      }),
    ).toMatchObject({
      defaultId: "research",
      ownership: "explicit",
      selectionRequired: false,
    });
  });

  it("retains disk system agents without treating regular disk dirs as roster members", async () => {
    await Promise.all(
      ["openclaw", "crestodian", "research"].map((id) =>
        fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
      ),
    );

    const syncRead = vi.spyOn(fsSync, "readdirSync").mockImplementation(() => {
      throw new Error("Roster inventory must not block the Gateway thread");
    });
    onTestFinished(() => syncRead.mockRestore());
    const cfg = { agents: { entries: { main: {} } } };
    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([
      { id: "main", kind: "agent", name: undefined },
      { id: "crestodian", kind: "system", name: undefined },
      { id: "openclaw", kind: "system", name: undefined },
    ]);
    await fs.rmdir(path.join(stateDir, "agents", "crestodian"));
    expect((await listGatewayAgentsBasic(cfg)).agents.map(({ id }) => id)).toEqual([
      "main",
      "openclaw",
    ]);
    expect(syncRead).not.toHaveBeenCalled();
  });

  it("lets configured ownership override disk system metadata", async () => {
    await fs.mkdir(path.join(stateDir, "agents", "openclaw"), { recursive: true });
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, openclaw: { name: "OpenClaw", identity: { name: "Fallback" } } },
      },
    };

    expect((await listGatewayAgentsBasic(cfg)).agents).toEqual([
      { id: "main", kind: "agent", name: undefined },
      { id: "openclaw", kind: "agent", name: "OpenClaw" },
    ]);
  });

  it("falls back to identity.name when the configured agent name is missing", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        entries: { main: { identity: { name: "小金" } } },
      },
    };

    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: "小金" }]);
  });
});
