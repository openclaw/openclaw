import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistClawInstallRecord } from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import {
  runClawsAddCommand,
  runClawsExportCommand,
  runClawsRemoveCommand,
  runClawsStatusCommand,
} from "./claws-cli.runtime.js";
import { runClawsMigrateCommand } from "./claws-migrate-cli.runtime.js";
import { runClawsUpdateCommand } from "./claws-update-cli.runtime.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    const filename = path.join(entry.parentPath, entry.name);
    snapshot[path.relative(root, filename)] = entry.isDirectory()
      ? "directory"
      : (await fs.readFile(filename)).toString("base64");
  }
  return snapshot;
}

describe("Claw CLI state ownership", () => {
  const fixture = useLocalStateOwnerFixture();
  const output: unknown[] = [];
  const runtime: OutputRuntimeEnv = {
    log: () => {},
    error: () => {},
    writeStdout: () => {},
    writeJson: (value) => output.push(value),
    exit: (code) => {
      throw new Error(`Claw command exited: ${code}; ${JSON.stringify(output.at(-1))}`);
    },
  };
  let root: string;
  let source: string;
  let workspace: string;

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    root = path.dirname(process.env.OPENCLAW_STATE_DIR!);
    vi.stubEnv("OPENCLAW_HOME", root);
    source = path.join(root, "claw.json");
    workspace = path.join(root, "workspace");
    output.length = 0;
    await fs.writeFile(source, JSON.stringify({ schemaVersion: 1, agent: { id: "demo" } }));
  });

  async function previewAdd() {
    await runClawsAddCommand(source, { dryRun: true, json: true, workspace }, runtime);
    return output.at(-1) as ClawAddPlan;
  }

  it("refuses live-owner composition and inspection without changing any state bytes", async () => {
    const plan = await previewAdd();
    expect(plan.blockers).toEqual([]);
    await runWithLocalStateOwner({
      method: "claws.add",
      params: {},
      target: "fixture provenance",
      runLocal: async () => {
        persistClawInstallRecord(plan, { status: "pending" });
      },
    });
    await fixture.startOwner();
    const before = await snapshotTree(root);
    expect(Object.keys(before)).toContain(path.join("state", "state", "openclaw.sqlite"));
    const consent = { yes: true, planIntegrity: plan.planIntegrity, json: true };
    const commands = [
      () => runClawsAddCommand(source, { ...consent, workspace }, runtime),
      () => runClawsAddCommand(source, { dryRun: true, json: true, workspace }, runtime),
      () => runClawsUpdateCommand("demo", { ...consent, from: source }, runtime),
      () => runClawsUpdateCommand("demo", { dryRun: true, json: true, from: source }, runtime),
      () => runClawsRemoveCommand("demo", consent, runtime),
      () => runClawsRemoveCommand("demo", { dryRun: true, json: true }, runtime),
      () => runClawsMigrateCommand("demo", consent, runtime),
      () => runClawsMigrateCommand("demo", { dryRun: true, json: true }, runtime),
      () => runClawsStatusCommand(undefined, { json: true }, runtime),
      () => runClawsExportCommand("demo", { out: path.join(root, "export"), json: true }, runtime),
    ];
    for (const command of commands) {
      await expect(command()).rejects.toThrow(
        /exclusive offline state ownership.*stop the Gateway/s,
      );
      expect(await snapshotTree(root)).toEqual(before);
    }
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });

  it("adds, updates, inspects, and exports through the offline owner", async () => {
    const plan = await previewAdd();
    expect(plan.blockers).toEqual([]);
    await runClawsAddCommand(
      source,
      { yes: true, planIntegrity: plan.planIntegrity, json: true, workspace },
      runtime,
    );
    expect(output.at(-1)).toMatchObject({ status: "complete", configCommitted: true });
    await fs.writeFile(
      source,
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo", name: "Updated demo" } }),
    );
    await runClawsUpdateCommand("demo", { dryRun: true, json: true, from: source }, runtime);
    const update = output.at(-1) as { planIntegrity: string; blockers: unknown[] };
    expect(update.blockers).toEqual([]);
    await runClawsUpdateCommand(
      "demo",
      { yes: true, planIntegrity: update.planIntegrity, json: true, from: source },
      runtime,
    );
    expect(output.at(-1)).toMatchObject({ status: "complete" });
    await runClawsStatusCommand("demo", { json: true }, runtime);
    expect(output.at(-1)).toMatchObject({ records: [{ agentState: "present" }] });
    await runClawsExportCommand("demo", { out: path.join(root, "export"), json: true }, runtime);
    expect(await fs.readFile(path.join(root, "export", "CLAW.md"), "utf8")).toContain(
      "Updated demo",
    );
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });

  it("migrates and removes adopted ownership offline while retaining the existing agent", async () => {
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "SOUL.md"), "Existing agent\n");
    await fs.writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ agents: { entries: { demo: { workspace } } } }),
    );
    await runClawsMigrateCommand("demo", { dryRun: true, json: true }, runtime);
    const migration = output.at(-1) as { planIntegrity: string };
    await runClawsMigrateCommand(
      "demo",
      { yes: true, planIntegrity: migration.planIntegrity, json: true },
      runtime,
    );
    await runClawsRemoveCommand("demo", { dryRun: true, json: true }, runtime);
    const removal = output.at(-1) as { planIntegrity: string; blockers: unknown[] };
    expect(removal.blockers).toEqual([]);
    await runClawsRemoveCommand(
      "demo",
      { yes: true, planIntegrity: removal.planIntegrity, json: true },
      runtime,
    );
    expect(output.at(-1)).toMatchObject({ status: "complete", agentRemoved: false });
    expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe("Existing agent\n");
    await runClawsStatusCommand(undefined, { json: true }, runtime);
    expect(output.at(-1)).toMatchObject({ records: [] });
    expect(fixture.transport.request).not.toHaveBeenCalled();
  });
});
