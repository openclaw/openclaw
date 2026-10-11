import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "./workspace-alias-rebind.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  deleteWorkspaceState,
  mergeWorkspaceSetupState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "./workspace-state-store.js";

const WORKSPACE_ATTESTATION_RECENT_MS = 24 * 60 * 60 * 1000;

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-move-" });
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

function link(target: string, alias: string) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}
function repoint(alias: string, target: string) {
  fs.unlinkSync(alias);
  link(target, alias);
}
async function movedWorkspace(attestationOnly = false) {
  const original = state.workspaceDir;
  const alias = state.path("workspace-link");
  const moved = state.path("moved-workspace");
  link(original, alias);
  fs.writeFileSync(path.join(original, "project.txt"), "user content");
  if (!attestationOnly) {
    await mergeWorkspaceSetupState(
      alias,
      {
        bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
        setupCompletedAt: "2026-07-16T02:00:00.000Z",
      },
      1000,
    );
  }
  await replaceWorkspaceAttestation({
    workspaceDir: alias,
    attestedAtMs: 1000,
    generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
    nowMs: 1000,
  });
  fs.renameSync(original, moved);
  repoint(alias, moved);
  return { original, alias, moved };
}

describe("workspace move recovery", () => {
  it("refuses a surviving Unicode sibling even when the normalized spelling points at the destination", async ({
    skip,
  }) => {
    const original = state.path("original-e\u0301");
    const normalized = original.normalize("NFC");
    const alias = state.path("unicode-link");
    const moved = state.path("unicode-copy");
    fs.mkdirSync(original);
    fs.mkdirSync(moved);
    link(original, alias);
    await mergeWorkspaceSetupState(alias, { setupCompletedAt: "2026-07-16T02:00:00.000Z" });
    if (fs.existsSync(normalized)) {
      skip();
    }
    link(moved, normalized);
    repoint(alias, moved);
    expect(await rebindRepointedWorkspaceAlias(alias, detectRepointedWorkspaceAlias(alias)!)).toBe(
      "original-workspace-exists",
    );
    expect((await readWorkspaceStateSnapshot(moved)).setupExists).toBe(false);
  });

  it("preserves attestation-only state without changing files", async () => {
    const { alias, moved } = await movedWorkspace(true);
    const facts = detectRepointedWorkspaceAlias(alias)!;
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("rebound");
    const snapshot = await readWorkspaceStateSnapshot(alias);
    expect(snapshot.setupExists).toBe(false);
    expect(snapshot.attestation).toEqual({
      attestedAtMs: 1000,
      generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
    });
    expect(fs.readFileSync(path.join(moved, "project.txt"), "utf8")).toBe("user content");
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("no-repoint");
    closeOpenClawStateDatabaseForTest();
    expect(await readWorkspaceStateSnapshot(alias)).toEqual(snapshot);
  });

  it("refuses a copy while the original folder still exists", async () => {
    const { original, alias, moved } = await movedWorkspace();
    fs.mkdirSync(original);
    const before = detectRepointedWorkspaceAlias(alias)!;
    expect(await rebindRepointedWorkspaceAlias(alias, before)).toBe("original-workspace-exists");
    expect((await readWorkspaceStateSnapshot(original)).setupExists).toBe(true);
    expect((await readWorkspaceStateSnapshot(moved)).setupExists).toBe(false);
  });

  it("does not merge an existing destination owner and still reports a typed repair failure", async () => {
    const { original, alias, moved } = await movedWorkspace();
    await mergeWorkspaceSetupState(moved, { bootstrapSeededAt: "2026-07-17T01:00:00.000Z" }, 2000);
    const facts = detectRepointedWorkspaceAlias(alias)!;
    await expect(readWorkspaceStateSnapshot(alias)).rejects.toThrow(WorkspaceAliasRepointedError);
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("current-target-owns-state");
    expect((await readWorkspaceStateSnapshot(original)).setup.setupCompletedAt).toBe(
      "2026-07-16T02:00:00.000Z",
    );
    expect((await readWorkspaceStateSnapshot(moved)).setup.bootstrapSeededAt).toBe(
      "2026-07-17T01:00:00.000Z",
    );
  });

  it("rejects changed setup records after confirmation facts were read", async () => {
    const { original, alias, moved } = await movedWorkspace();
    const facts = detectRepointedWorkspaceAlias(alias)!;
    await mergeWorkspaceSetupState(original, {}, 3000);
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("repoint-changed");
    expect((await readWorkspaceStateSnapshot(moved)).setupExists).toBe(false);
  });

  it("rejects a replacement directory at the same approved path", async () => {
    const { alias, moved } = await movedWorkspace();
    const facts = detectRepointedWorkspaceAlias(alias)!;
    fs.renameSync(moved, state.path("retained-content"));
    fs.mkdirSync(moved);
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("repoint-changed");
    expect((await readWorkspaceStateSnapshot(moved)).setupExists).toBe(false);
  });

  it("protects a configured alias before its first workspace access", async () => {
    const { original, alias, moved } = await movedWorkspace();
    const unused = state.path("unused-link");
    link(original, unused);
    const facts = detectRepointedWorkspaceAlias(alias)!;
    expect(await rebindRepointedWorkspaceAlias(alias, facts, {}, [alias, unused])).toBe(
      "configured-workspace-conflict",
    );
    expect((await readWorkspaceStateSnapshot(original)).setupExists).toBe(true);
    expect((await readWorkspaceStateSnapshot(moved)).setupExists).toBe(false);
  });

  it("keeps verified sibling aliases but removes old paths from the moved owner's cleanup", async () => {
    const original = state.workspaceDir;
    const first = state.path("first-link");
    const second = state.path("second-link");
    const moved = state.path("moved");
    link(original, first);
    link(original, second);
    await mergeWorkspaceSetupState(first, { setupCompletedAt: "2026-07-16T02:00:00.000Z" }, 1000);
    await readWorkspaceStateSnapshot(second);
    fs.renameSync(original, moved);
    repoint(first, moved);
    repoint(second, moved);
    expect(
      await rebindRepointedWorkspaceAlias(first, detectRepointedWorkspaceAlias(first)!, {}, [
        first,
        second,
      ]),
    ).toBe("rebound");
    const snapshot = await readWorkspaceStateSnapshot(second);
    await deleteWorkspaceState(prepareWorkspaceStateDeletion(original));
    await clearExpiredWorkspaceStateForVanishedWorkspace(
      original,
      WORKSPACE_ATTESTATION_RECENT_MS + 2000,
    );
    expect(await readWorkspaceStateSnapshot(first)).toEqual(snapshot);
    fs.mkdirSync(original);
    await mergeWorkspaceSetupState(
      original,
      { bootstrapSeededAt: "2026-07-18T01:00:00.000Z" },
      4000,
    );
    expect(await readWorkspaceStateSnapshot(second)).toEqual(snapshot);
  });

  it("rejects malformed persisted attestation before it can be transferred", async () => {
    const { alias } = await movedWorkspace();
    openOpenClawStateDatabase()
      .db.prepare("UPDATE workspace_generated_bootstrap_hashes SET filename = '../outside.md'")
      .run();
    expect(() => detectRepointedWorkspaceAlias(alias)).toThrow(
      "workspace attestation hash row is invalid",
    );
  });
});
