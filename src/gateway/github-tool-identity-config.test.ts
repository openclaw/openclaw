import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readAgentLifecycleStoreFacts } from "../state/agent-lifecycle-read.worker.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { seedAgentProvenance } from "../test-utils/agent-provenance.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";

const mocks = vi.hoisted(() => ({
  mutateConfigFileWithRetry: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));

import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("GitHub identity config mutation", () => {
  it.each([undefined, false, true])(
    "preserves sandbox opt-in %s across replacement and removes it on inherit",
    async (allowInSandbox) => {
      const sandboxPolicy = allowInSandbox === undefined ? {} : { allowInSandbox };
      const previousIdentity = { profileId: `ghp_${"1".repeat(32)}`, ...sandboxPolicy };
      const nextIdentity = { profileId: `ghp_${"2".repeat(32)}`, kind: "oauth" as const };
      const draft: OpenClawConfig = {
        agents: { entries: { main: { tools: { github: previousIdentity } } } },
      };
      mocks.mutateConfigFileWithRetry.mockImplementation(async ({ mutate }) => {
        await mutate(draft);
        return { nextConfig: draft };
      });

      await updateGitHubToolIdentityConfig({
        scope: "agent",
        agentId: "main",
        identity: nextIdentity,
        expectedIdentity: previousIdentity,
      });
      expect(draft.agents?.entries?.main?.tools?.github).toStrictEqual({
        ...nextIdentity,
        ...sandboxPolicy,
      });

      await updateGitHubToolIdentityConfig({
        scope: "agent",
        agentId: "main",
        expectedIdentity: { ...nextIdentity, ...sandboxPolicy },
      });
      expect(draft.agents?.entries?.main?.tools?.github).toBeUndefined();
    },
  );

  it("rejects a recreated agent at draft mutation despite accepted stale worker facts", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("github-identity-incarnation-"));
    try {
      seedAgentProvenance("main", { createdVia: "operator" }, { nowMs: 1 });
      const database = openOpenClawStateDatabase();
      const prepared = readAgentLifecycleStoreFacts(database.db, "main");
      // An accepted reply can predate a foreign commit before the draft is mutated.
      vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockResolvedValue({
        ok: true,
        sourceAdmitted: true,
        type: "agentLifecycle.read",
        facts: prepared,
      });
      const draft: OpenClawConfig = { agents: { entries: { main: {} } } };
      mocks.mutateConfigFileWithRetry.mockImplementation(async ({ mutate }) => {
        seedAgentProvenance("main", { createdVia: "operator" }, { nowMs: 2 });
        await mutate(draft);
        return { nextConfig: draft };
      });

      await expect(
        updateGitHubToolIdentityConfig({
          scope: "agent",
          agentId: "main",
          identity: { profileId: `ghp_${"1".repeat(32)}`, kind: "oauth" },
          expectedIdentity: null,
          agentLifecycleBinding: { agentId: "main", provenance: prepared.provenance },
        }),
      ).rejects.toThrow("Agent changed while GitHub setup was in progress.");

      expect(draft.agents?.entries?.main?.tools?.github).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await closeStateDatabaseForTest();
      vi.unstubAllEnvs();
    }
  });
});
