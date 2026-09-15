import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { createUpdatePlanFixture, packagePreflight } from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(options?: Parameters<typeof createUpdatePlanFixture>[1]) {
  const root = tempDirs.make("openclaw-claw-update-");
  return await createUpdatePlanFixture(root, options);
}

describe("buildClawUpdatePlan adopted agent", () => {
  it("preserves an adopted agent default marker when planning an update", async () => {
    const current = await fixture();
    const entry = current.config.agents?.entries?.worker;
    if (!entry) {
      throw new Error("fixture agent missing");
    }
    entry.default = true;
    const recordedAgent = { id: "worker", ...entry };
    const recordedDigest = `sha256:${createHash("sha256")
      .update(stableStringify(recordedAgent))
      .digest("hex")}`;
    openOpenClawStateDatabase({ env: current.env })
      .db.prepare(
        `UPDATE claw_installs
            SET schema_version = ?, agent_config_digest = ?, agent_owned_paths_json = ?
          WHERE agent_id = ?`,
      )
      .run(
        CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION,
        recordedDigest,
        JSON.stringify({ origin: "adopted", paths: ['agents.entries["worker"]'] }),
        "worker",
      );
    current.config.agents = {
      ...current.config.agents,
      entries: { WORKER: entry },
    };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "unchanged" }),
    );
  });

  it("never restores a missing adopted agent without its captured default marker", async () => {
    const current = await fixture();
    const db = openOpenClawStateDatabase({ env: current.env }).db;
    db.prepare(
      `UPDATE claw_installs SET schema_version = ?, agent_owned_paths_json = ? WHERE agent_id = ?`,
    ).run(
      CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION,
      JSON.stringify({ origin: "adopted", paths: ['agents.entries["worker"]'] }),
      "worker",
    );
    current.config.agents = { ...current.config.agents, entries: {} };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "manual", blocked: true }),
    );
  });
});
