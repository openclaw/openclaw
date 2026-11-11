import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  detectRepointedWorkspaceAlias as detectMove,
  rebindRepointedWorkspaceAlias as rebindMove,
} from "./workspace-alias-rebind.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace as clearExpiredState,
  deleteWorkspaceState,
  mergeWorkspaceSetupState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot as readState,
  replaceWorkspaceAttestation,
} from "./workspace-state-store.js";

const completedAt = "2026-07-16T02:00:00.000Z";
const setup = { bootstrapSeededAt: "2026-07-16T01:00:00.000Z", setupCompletedAt: completedAt };
const destinationSetup = { bootstrapSeededAt: "2026-07-17T01:00:00.000Z" };
const attestation = () => ({
  attestedAtMs: 1000,
  generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
});

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
    await mergeWorkspaceSetupState(alias, setup, 1000);
  }
  await replaceWorkspaceAttestation({ workspaceDir: alias, ...attestation(), nowMs: 1000 });
  fs.renameSync(original, moved);
  repoint(alias, moved);
  return { original, alias, moved };
}

it("refuses a surviving Unicode sibling despite a normalized destination alias", async ({
  skip,
}) => {
  const original = state.path("original-e\u0301");
  const normalized = original.normalize("NFC");
  const alias = state.path("unicode-link");
  const moved = state.path("unicode-copy");
  fs.mkdirSync(original);
  fs.mkdirSync(moved);
  link(original, alias);
  await mergeWorkspaceSetupState(alias, { setupCompletedAt: completedAt });
  if (fs.existsSync(normalized)) {
    skip();
  }
  link(moved, normalized);
  repoint(alias, moved);
  expect(await rebindMove(alias, detectMove(alias)!)).toBe("original-workspace-exists");
  expect((await readState(moved)).setupExists).toBe(false);
});

it("preserves attestation-only state without changing files", async () => {
  const { alias, moved } = await movedWorkspace(true);
  const facts = detectMove(alias)!;
  expect(await rebindMove(alias, facts)).toBe("rebound");
  const snapshot = await readState(alias);
  expect(snapshot.setupExists).toBe(false);
  expect(snapshot.attestation).toEqual(attestation());
  expect(fs.readFileSync(path.join(moved, "project.txt"), "utf8")).toBe("user content");
  expect(await rebindMove(alias, facts)).toBe("no-repoint");
  closeOpenClawStateDatabaseForTest();
  expect(await readState(alias)).toEqual(snapshot);
});

it.each([
  ["surviving original", "original-workspace-exists"],
  ["configured alias", "configured-workspace-conflict"],
  ["destination owner", "current-target-owns-state"],
] as const)("refuses a move with a %s", async (conflict, outcome) => {
  const { original, alias, moved } = await movedWorkspace();
  const unused = state.path("unused-link");
  if (conflict === "surviving original") {
    fs.mkdirSync(original);
  } else if (conflict === "configured alias") {
    link(original, unused);
  } else {
    await mergeWorkspaceSetupState(moved, destinationSetup, 2000);
    await expect(readState(alias)).rejects.toThrow(WorkspaceAliasRepointedError);
  }
  const configured = conflict === "configured alias" ? [alias, unused] : undefined;
  expect(await rebindMove(alias, detectMove(alias)!, {}, configured)).toBe(outcome);
  expect(await readState(original)).toMatchObject({ setupExists: true, setup });
  expect(await readState(moved)).toMatchObject(
    conflict === "destination owner"
      ? { setupExists: true, setup: destinationSetup }
      : { setupExists: false },
  );
});

it.each(["setup records", "directory identity"])(
  "rejects changed %s after confirmation",
  async (change) => {
    const { original, alias, moved } = await movedWorkspace();
    const facts = detectMove(alias)!;
    if (change === "setup records") {
      await mergeWorkspaceSetupState(original, {}, 3000);
    } else {
      fs.renameSync(moved, state.path("retained-content"));
      fs.mkdirSync(moved);
    }
    expect(await rebindMove(alias, facts)).toBe("repoint-changed");
    expect((await readState(moved)).setupExists).toBe(false);
  },
);

it("keeps verified sibling aliases but removes old paths from the moved owner's cleanup", async () => {
  const original = state.workspaceDir;
  const first = state.path("first-link");
  const second = state.path("second-link");
  const moved = state.path("moved");
  link(original, first);
  link(original, second);
  await mergeWorkspaceSetupState(first, { setupCompletedAt: completedAt }, 1000);
  await readState(second);
  fs.renameSync(original, moved);
  repoint(first, moved);
  repoint(second, moved);
  expect(await rebindMove(first, detectMove(first)!, {}, [first, second])).toBe("rebound");
  const snapshot = await readState(second);
  await deleteWorkspaceState(prepareWorkspaceStateDeletion(original));
  await clearExpiredState(original, 24 * 60 * 60 * 1000 + 2000);
  expect(await readState(first)).toEqual(snapshot);
  fs.mkdirSync(original);
  await mergeWorkspaceSetupState(original, { bootstrapSeededAt: "2026-07-18T01:00:00.000Z" }, 4000);
  expect(await readState(second)).toEqual(snapshot);
});

it("rejects malformed persisted attestation before it can be transferred", async () => {
  const { alias } = await movedWorkspace();
  openOpenClawStateDatabase()
    .db.prepare("UPDATE workspace_generated_bootstrap_hashes SET filename = '../outside.md'")
    .run();
  expect(() => detectMove(alias)).toThrow("workspace attestation hash row is invalid");
});
