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

function invalidDeleteOutput(marker: string, tail: string, maxBytes: string) {
  const { outputPath, run } = workspaceFixture();
  writeFileSync(outputPath, `${marker}${"x".repeat(70 * 1024)}\n${tail}`, "utf8");
  const result = run(maxBytes);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(tail);
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

  it("rejects oversized agents delete output before parsing it", () => {
    const result = invalidDeleteOutput(
      "DO_NOT_DUMP_OLD_AGENTS_DELETE",
      "recent agents delete tail",
      "1024",
    );
    expect(result.stderr).toContain("agents delete --json output exceeded 1024 bytes");
    expect(result.stderr).not.toContain("DO_NOT_DUMP_OLD_AGENTS_DELETE");
  });

  it("bounds invalid agents delete JSON diagnostics", () => {
    const result = invalidDeleteOutput(
      "DO_NOT_DUMP_OLD_INVALID_JSON",
      "recent invalid json tail",
      "131072",
    );
    expect(result.stderr).toContain("agents delete --json did not emit valid JSON");
    // Node can quote only a short input prefix, while Bun includes more of the same marker.
    expect(result.stderr).not.toContain("DO_NOT_");
    expect(result.stderr).toContain(result.outputPath);
  });

  it.each(["local", undefined])("rejects deletion output with transport %s", (transport) => {
    const result = runSharedWorkspaceDelete(transport);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("transport mismatch");
  });
});
