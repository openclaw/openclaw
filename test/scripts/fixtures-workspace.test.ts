import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const FIXTURE_SCRIPT = "scripts/e2e/lib/fixture.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workspaceFixture() {
  const root = tempDirs.make("openclaw-fixture-workspace-");
  const workspace = path.join(root, "workspace");
  const outputPath = path.join(root, "agents-delete.json");
  const agentsPath = path.join(root, "agents.json");
  mkdirSync(workspace);
  const run = (maxBytes?: string) =>
    spawnSync(process.execPath, [FIXTURE_SCRIPT, "agents-delete-assert", outputPath, agentsPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        SHARED_WORKSPACE: workspace,
        ...(maxBytes ? { OPENCLAW_FIXTURE_AGENTS_DELETE_OUTPUT_MAX_BYTES: maxBytes } : {}),
      },
    });
  return { workspace, outputPath, agentsPath, run };
}

function runSharedWorkspaceDelete(transport: string | undefined) {
  const { workspace, outputPath, agentsPath, run } = workspaceFixture();
  writeFileSync(
    outputPath,
    JSON.stringify({
      agentId: "ops",
      workspace,
      workspaceRetained: true,
      workspaceRetainedReason: "shared",
      workspaceSharedWith: ["alpha"],
      transport,
    }) + "\n",
  );
  writeFileSync(agentsPath, JSON.stringify([{ id: "alpha", workspace }]) + "\n");
  return run();
}

function invalidDeleteOutput(maxBytes: string) {
  const { outputPath, run } = workspaceFixture();
  writeFileSync(
    outputPath,
    `DO_NOT_DUMP_OLD${"x".repeat(70 * 1024)}\nrecent diagnostic tail`,
    "utf8",
  );
  const result = run(maxBytes);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("recent diagnostic tail");
  // Node and Bun expose different prefix lengths in their JSON parse errors.
  expect(result.stderr).not.toContain("DO_NOT_");
  return { ...result, outputPath };
}

describe("workspace fixture assertions", () => {
  it("requires gateway deletion and retains the shared surviving agent", () => {
    const result = runSharedWorkspaceDelete("gateway");
    expect(result.status).toBe(0);
  });

  it("prepares Open WebUI without retired workspace setup state", () => {
    const { workspace: workspaceDir } = workspaceFixture();
    const rootStatePath = path.join(workspaceDir, "openclaw-workspace-state.json");
    writeFileSync(rootStatePath, "{}\n");
    const result = spawnSync(process.execPath, [FIXTURE_SCRIPT, "openwebui-workspace"], {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspaceDir },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(path.join(workspaceDir, "IDENTITY.md"), "utf8")).toContain(
      "Open WebUI Docker compatibility smoke test assistant.",
    );
    expect(existsSync(rootStatePath)).toBe(false);
  });

  it.each([
    ["1024", "output exceeded 1024 bytes"],
    ["131072", "did not emit valid JSON"],
  ])("bounds agents-delete diagnostics with a %s byte limit", (limit, error) => {
    const result = invalidDeleteOutput(limit);
    expect(result.stderr).toContain(`agents delete --json ${error}`);
    if (limit === "131072") {
      expect(result.stderr).toContain(result.outputPath);
    }
  });

  it.each(["local", undefined])("rejects deletion output with transport %s", (transport) => {
    const result = runSharedWorkspaceDelete(transport);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("transport mismatch");
  });
});
