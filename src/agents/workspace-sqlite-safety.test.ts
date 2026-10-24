import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-identity.js";
import { mergeWorkspaceSetupState, readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  WORKSPACE_VANISHED_ERROR_CODE,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;
let tempDir: string;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-sqlite-safety-",
  });
  tempDir = await makeTempWorkspace("openclaw-workspace-");
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

function deleteWorkspaceAttestation(workspaceDir: string): void {
  const key = resolveWorkspaceStateIdentity(workspaceDir).workspaceKey;
  const db = openOpenClawStateDatabase().db;
  // Mirrors the pre-v13 attestation-row delete: clearing the merged columns
  // must also drop the generated hashes the old FK cascade removed.
  db.prepare(
    `UPDATE workspace_setup_state
        SET attested_at_ms = NULL, attestation_updated_at_ms = NULL
      WHERE workspace_key = ?`,
  ).run(key);
  db.prepare("DELETE FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?").run(key);
}

const seed = (dir: string) => ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
const bootstrapPath = (dir: string) => path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
const expectVanished = (result: ReturnType<typeof ensureAgentWorkspace>) =>
  expect(result).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
    name: "WorkspaceVanishedError",
  });
const expectNoBootstrap = (dir: string) =>
  expect(fs.access(bootstrapPath(dir))).rejects.toHaveProperty("code", "ENOENT");

async function leaveGeneratedRemnant(dir: string) {
  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const content = await fs.readFile(agentsPath, "utf8");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(agentsPath, content);
}

it.each([false, true])("clears expired remnants (attested: %s)", async (attested) => {
  await seed(tempDir);
  const key = resolveWorkspaceStateIdentity(tempDir).workspaceKey;
  const expiredAtMs = Date.now() - 25 * 60 * 60 * 1000;
  const db = openOpenClawStateDatabase().db;
  if (attested) {
    db.prepare(
      "UPDATE workspace_setup_state SET attested_at_ms = ?, attestation_updated_at_ms = ? WHERE workspace_key = ?",
    ).run(expiredAtMs, expiredAtMs, key);
  } else {
    deleteWorkspaceAttestation(tempDir);
  }
  db.prepare("UPDATE workspace_setup_state SET updated_at = ? WHERE workspace_key = ?").run(
    expiredAtMs,
    key,
  );
  await leaveGeneratedRemnant(tempDir);
  await seed(tempDir);
  await fs.access(bootstrapPath(tempDir));
  expect((await readWorkspaceStateSnapshot(tempDir)).setup.setupCompletedAt).toBeUndefined();
});

it.each([false, true])("refuses recent setup-only state (missing: %s)", async (missing) => {
  await mergeWorkspaceSetupState(tempDir, {
    bootstrapSeededAt: new Date().toISOString(),
  });
  if (missing) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  await expectVanished(ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: missing }));
  if (missing) {
    await expect(fs.access(tempDir)).rejects.toHaveProperty("code", "ENOENT");
  }
});

it("accepts a customized profile with migrated setup-only state", async () => {
  const identityPath = path.join(tempDir, DEFAULT_IDENTITY_FILENAME);
  await fs.writeFile(identityPath, "# Existing identity\n");
  await mergeWorkspaceSetupState(tempDir, {
    setupCompletedAt: "2026-07-15T10:01:00.000Z",
  });

  await expect(seed(tempDir)).resolves.toMatchObject({ dir: tempDir });
  await expect(fs.readFile(identityPath, "utf8")).resolves.toBe("# Existing identity\n");
});

it("refuses to trust setup-only state after only generated remnants survive", async () => {
  await seed(tempDir);
  deleteWorkspaceAttestation(tempDir);
  await leaveGeneratedRemnant(tempDir);
  await expectVanished(seed(tempDir));
  await expectNoBootstrap(tempDir);
});

it("accepts an intact generated workspace with setup-only state", async () => {
  await seed(tempDir);
  await fs.rm(bootstrapPath(tempDir));
  await seed(tempDir);
  deleteWorkspaceAttestation(tempDir);

  await expect(seed(tempDir)).resolves.toMatchObject({ dir: tempDir });
  await expectNoBootstrap(tempDir);
});
