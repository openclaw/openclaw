import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  localWorkspaceProjectionFixture,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("correlates oversized journal bytes without logging their contents or changing the rate limit", async () => {
  const root = dirs.make("workspace-diagnostics-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const worktreeId = randomUUID();
  const pendingRef = "refs/openclaw/results/private-plan";
  const pack = Buffer.alloc(1024 * 1024 + 1, 71);
  const journal = JSON.stringify({
    basePackSha256: createHash("sha256").update(pack).digest("hex"),
    baseEntries: [{ path: "private-file" }],
    appliedEntries: [],
  });
  const digest = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex").slice(0, 16);
  const warnings: string[] = [];
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "warn");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    const line = String(chunk);
    if (line.includes("Local workspace oversized mutation:")) {
      warnings.push(line);
    }
    return true;
  });
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const created = await store.create({
      ...localWorkspaceProjectionFixture(worktreeId, root),
      pending_ref: pendingRef,
    });
    const patch = { journal_json: journal, journal_pack: pack };
    const persisted = await store.update(created, patch);
    await store.update(persisted, patch);
  });
  await closeOpenClawStateDatabaseAsync();
  stderr.mockRestore();
  vi.unstubAllEnvs();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(
    `journalPackSha256=${digest(pack)} journalJsonSha256=${digest(journal)}`,
  );
  expect(warnings[0]).toContain(
    `"workspace":"${digest(worktreeId)}","plan":"${digest(pendingRef)}"`,
  );
  for (const privateValue of [worktreeId, pendingRef, "private-file", root]) {
    expect(warnings[0]).not.toContain(privateValue);
  }
  const recovered = await readLocalWorkspaceProjection(worktreeId, env);
  expect(recovered?.journal_json).toBe(journal);
  expect(Buffer.compare(recovered!.journal_pack!, pack)).toBe(0);
});
