import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const FIXTURE_SCRIPT = "scripts/e2e/lib/fixture.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runDelete(transport?: string, maxBytes?: string) {
  const root = tempDirs.make("openclaw-fixture-workspace-");
  const workspace = path.join(root, "workspace");
  const outputPath = path.join(root, "agents-delete.json");
  const agentsPath = path.join(root, "agents.json");
  mkdirSync(workspace);
  writeFileSync(agentsPath, JSON.stringify([{ id: "alpha", workspace }]) + "\n");
  writeFileSync(
    outputPath,
    maxBytes
      ? `DO_NOT_DUMP_OLD${"x".repeat(70 * 1024)}\nrecent diagnostic tail`
      : JSON.stringify({
          agentId: "ops",
          workspace,
          workspaceRetained: true,
          workspaceRetainedReason: "shared",
          workspaceSharedWith: ["alpha"],
          transport,
        }) + "\n",
  );
  return {
    outputPath,
    ...spawnSync(
      process.execPath,
      [FIXTURE_SCRIPT, "agents-delete-assert", outputPath, agentsPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          SHARED_WORKSPACE: workspace,
          ...(maxBytes ? { OPENCLAW_FIXTURE_AGENTS_DELETE_OUTPUT_MAX_BYTES: maxBytes } : {}),
        },
      },
    ),
  };
}

describe("workspace fixture assertions", () => {
  it("requires gateway deletion and retains the shared surviving agent", () => {
    const result = runDelete("gateway");
    expect(result.status).toBe(0);
  });

  it("prepares Open WebUI without retired workspace setup state", () => {
    const workspaceDir = tempDirs.make("openclaw-fixture-workspace-");
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
    const result = runDelete(undefined, limit);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recent diagnostic tail");
    expect(result.stderr).not.toContain("DO_NOT_");
    expect(result.stderr).toContain(`agents delete --json ${error}`);
    if (limit === "131072") {
      expect(result.stderr).toContain(result.outputPath);
    }
  });

  it.each(["local", undefined])("rejects deletion output with transport %s", (transport) => {
    const result = runDelete(transport);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("transport mismatch");
  });
});
