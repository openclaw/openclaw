import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { mergeWorkspaceSetupState, readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
  resolveWorkspaceBootstrapStatus,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-preseeded-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

describe("preseeded workspace bootstrap", () => {
  it("preserves BOOTSTRAP.md in a preseeded workspace with a custom profile", async () => {
    const tempDir = await makeTempWorkspace("openclaw-preseeded-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "# IDENTITY.md\n\n- **Name:** Preseeded\n",
    });
    mergeWorkspaceSetupState(tempDir, { bootstrapSeededAt: new Date().toISOString() }, 1_000);

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
    await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(true);
  });

  it("keeps BOOTSTRAP.md pending across restart before first bootstrap run", async () => {
    const tempDir = await makeTempWorkspace("openclaw-preseeded-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "# IDENTITY.md\n\n- **Name:** Restart\n",
    });
    mergeWorkspaceSetupState(tempDir, { bootstrapSeededAt: new Date().toISOString() }, 1_000);

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    expect(readWorkspaceStateSnapshot(tempDir).setup.setupCompletedAt).toBeUndefined();

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
  });

  it("does not treat preseeded workspace skills as bootstrap completion evidence", async () => {
    const tempDir = await makeTempWorkspace("openclaw-preseeded-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_IDENTITY_FILENAME,
      content: "# IDENTITY.md\n\n- **Name:** Skills\n",
    });
    await fs.mkdir(path.join(tempDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "skills", "example.md"), "# Example Skill\n");
    mergeWorkspaceSetupState(tempDir, { bootstrapSeededAt: new Date().toISOString() }, 1_000);

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
    expect(readWorkspaceStateSnapshot(tempDir).setup.setupCompletedAt).toBeUndefined();
  });
});
