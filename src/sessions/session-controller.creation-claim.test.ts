import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runWithAgentCreationClaim } from "../state/agent-creation-claim.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertAgentControllerDeletionAdmissionOpen } from "./session-controller.lifecycle-agent.js";

const { readJournal } = vi.hoisted(() => ({ readJournal: vi.fn() }));
// mock-isolation: Journal facts are controlled; matching and expiring creation authority stays real.
vi.mock("../state/agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: readJournal,
}));
afterEach(() => vi.resetAllMocks());

const env = { OPENCLAW_STATE_DIR: path.resolve("synthetic-creation-admission") };
const target = { agentId: "recreated", statePath: resolveOpenClawStateSqlitePath(env) };
const signal = new AbortController().signal;
const admit = () => assertAgentControllerDeletionAdmissionOpen(target, env, signal);

it.each([
  ["absent", undefined, true],
  ["complete", undefined, false],
  ["pending", "recreated", false],
  ["complete", "unrelated", false],
  ["complete", "recreated", true],
] as const)(
  "admits %s only with matching creation authority (%s)",
  async (status, creator, allowed) => {
    readJournal.mockResolvedValue(status);
    const operation = creator
      ? runWithAgentCreationClaim({ agentId: creator, env }, admit)
      : admit();
    if (allowed) {
      await expect(operation).resolves.toBeUndefined();
    } else {
      await expect(operation).rejects.toThrow("deletion is in progress");
    }
  },
);

it("refuses a matching agent claim from another state directory", async () => {
  readJournal.mockResolvedValue("complete");
  await expect(
    runWithAgentCreationClaim(
      {
        agentId: target.agentId,
        env: { OPENCLAW_STATE_DIR: path.resolve("synthetic-other-creation") },
      },
      admit,
    ),
  ).rejects.toThrow("deletion is in progress");
});

it("rechecks creation authority after the journal await", async () => {
  const journal = createDeferred<"complete">();
  readJournal.mockReturnValue(journal.promise);
  let pending: Promise<void> | undefined;
  await runWithAgentCreationClaim({ agentId: target.agentId, env }, async () => {
    pending = admit();
  });
  journal.resolve("complete");
  await expect(pending).rejects.toThrow("deletion is in progress");
});
