// Workspace attestation survival tests cover generated-file provenance across
// template changes and ignore retired generated-file evidence.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import {
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  WORKSPACE_VANISHED_ERROR_CODE,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-attestation-survival-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

async function makeWorkspace(): Promise<string> {
  return fs.realpath(tempDirs.make("openclaw-workspace-attestation-survival-"));
}

async function expectWorkspaceVanished(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
    name: "WorkspaceVanishedError",
  });
}

describe("workspace attestation survival", () => {
  it.each([DEFAULT_SOUL_FILENAME, DEFAULT_IDENTITY_FILENAME, DEFAULT_USER_FILENAME])(
    "keeps onboarding pending across restarts when attested %s came from an older template",
    async (fileName) => {
      const tempDir = await makeWorkspace();
      const filePath = path.join(tempDir, fileName);
      const bootstrapPath = path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME);
      await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
      const snapshot = await readWorkspaceStateSnapshot(tempDir);
      const oldTemplate = `# ${fileName}\n\nInstructions from an earlier default template.\n`;
      await fs.writeFile(filePath, oldTemplate);
      const generatedHashes = new Map(snapshot.attestation!.generatedHashes);
      generatedHashes.set(fileName, createHash("sha256").update(oldTemplate).digest("hex"));
      await replaceWorkspaceAttestation({
        workspaceDir: tempDir,
        attestedAtMs: Date.now() + 1,
        generatedHashes,
      });

      // Model an upgrade with the previous release's generated content and receipt.
      // Repeating setup also catches a refresh discarding the historical receipt.
      for (let restart = 0; restart < 2; restart++) {
        closeOpenClawStateDatabaseForTest();
        await expect(
          ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
        ).resolves.toMatchObject({ bootstrapPending: true });
        await expect(fs.access(bootstrapPath)).resolves.toBeUndefined();
        const state = (await readWorkspaceStateSnapshot(tempDir)).setup;
        expect(state.bootstrapSeededAt).toBe(snapshot.setup.bootstrapSeededAt);
        expect(state.setupCompletedAt).toBeUndefined();
        expect(await fs.readFile(filePath, "utf-8")).toBe(oldTemplate);
        await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: false });
      }

      await fs.writeFile(filePath, "A real profile update.\n");
      await expect(
        ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
      ).resolves.toMatchObject({ bootstrapPending: false });
      await expect(fs.access(bootstrapPath)).rejects.toHaveProperty("code", "ENOENT");
      expect((await readWorkspaceStateSnapshot(tempDir)).setup.setupCompletedAt).toMatch(
        /\d{4}-\d{2}-\d{2}T/,
      );
    },
  );

  it("ignores retired generated-file hashes", async () => {
    const tempDir = await makeWorkspace();
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.rm(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    const snapshot = await readWorkspaceStateSnapshot(tempDir);
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes: new Map([
        ...snapshot.attestation!.generatedHashes,
        ["RETIRED.md", "a".repeat(64)],
      ]),
    });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).resolves.toMatchObject({ dir: tempDir });
  });

  it("requires an AGENTS.md hash before trusting generated-file evidence", async () => {
    const tempDir = await makeWorkspace();
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.rm(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    const snapshot = await readWorkspaceStateSnapshot(tempDir);
    const generatedHashes = new Map(snapshot.attestation!.generatedHashes);
    generatedHashes.delete(DEFAULT_AGENTS_FILENAME);
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes,
    });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
  });

  it("accepts customized AGENTS.md when its attestation hash is missing", async () => {
    const tempDir = await makeWorkspace();
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.rm(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "custom instructions\n");
    const snapshot = await readWorkspaceStateSnapshot(tempDir);
    const generatedHashes = new Map(snapshot.attestation!.generatedHashes);
    generatedHashes.delete(DEFAULT_AGENTS_FILENAME);
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes,
    });

    await expect(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    ).resolves.toMatchObject({ dir: tempDir });
  });

  it("rejects a corrupted AGENTS.md attestation hash", async () => {
    const tempDir = await makeWorkspace();
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.rm(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    const snapshot = await readWorkspaceStateSnapshot(tempDir);
    const generatedHashes = new Map(snapshot.attestation!.generatedHashes);
    generatedHashes.set(DEFAULT_AGENTS_FILENAME, "0".repeat(64));
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes,
    });

    await expectWorkspaceVanished(
      ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true }),
    );
  });
});
