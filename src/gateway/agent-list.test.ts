/**
 * Gateway agent-list RPC regression tests.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("listGatewayAgentsBasic", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-agent-list-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("projects sole, retained-legacy, and explicit fleet ownership honestly", async () => {
    expect(await listGatewayAgentsBasic({ agents: { entries: { ops: {} } } })).toMatchObject({
      defaultId: "ops",
      ownership: "sole",
      selectionRequired: false,
    });

    const legacy = retainLegacyDefaultAgentId(
      { agents: { entries: { first: {}, retired: {}, research: {} } } },
      "retired",
    );
    expect(await listGatewayAgentsBasic(legacy)).toMatchObject({
      defaultId: "retired",
      ownership: "legacy",
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
    const cfg = { agents: { entries: { main: { default: true } } } };
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

  it("does not add owner entries without a roster membership source", async () => {
    expect(
      (
        await listGatewayAgentsBasic({
          agents: { entries: { main: { default: true } } },
        })
      ).agents,
    ).toEqual([{ id: "main", kind: "agent", name: undefined }]);
  });

  it("lets configured ownership override disk system metadata", async () => {
    await fs.mkdir(path.join(stateDir, "agents", "openclaw"), { recursive: true });
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "openclaw", name: "OpenClaw" },
        ],
      },
    };

    expect((await listGatewayAgentsBasic(cfg)).agents).toEqual([
      { id: "main", kind: "agent", name: undefined },
      { id: "openclaw", kind: "agent", name: "OpenClaw" },
    ]);
  });

  it("retains disk-backed system agents beside an explicit roster", async () => {
    await Promise.all(
      ["openclaw", "research"].map((id) =>
        fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
      ),
    );

    expect(
      (
        await listGatewayAgentsBasic({
          agents: { entries: { main: { default: true } } },
        })
      ).agents,
    ).toEqual([
      { id: "main", kind: "agent", name: undefined },
      { id: "openclaw", kind: "system", name: undefined },
    ]);
  });

  it("falls back to identity.name when the configured agent name is missing", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true, identity: { name: "小金" } }],
      },
    };

    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: "小金" }]);
  });

  it("prefers the explicit configured name over identity.name", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            name: "Ops",
            identity: { name: "开发助手" },
          },
        ],
      },
    };

    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: "Ops" }]);
  });

  it("leaves the name unset when neither agents.list[].name nor identity.name is present", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true, identity: {} }],
      },
    };

    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: undefined }]);
  });
});
