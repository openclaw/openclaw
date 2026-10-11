import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { recordDefaultProactiveJobInDatabase } from "../proactive-job-receipt.js";
import { resolveCronJobsStorePathFromConfig } from "../store/paths.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  preparedRunPluginRegistryMock,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  mockRunCronFallbackPassthrough();
});

afterEach(() => resetGlobalHookRunner());

it.each(["migrated", "unrelated", "missing-receipt"] as const)(
  "preserves proactive prompt hooks through the isolated run entry: %s",
  async (kind) => {
    await withOpenClawTestState({ label: "isolated-proactive-hook" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const jobId = "proactive-job";
      if (kind !== "missing-receipt") {
        runOpenClawStateWriteTransaction(({ db }) => {
          recordDefaultProactiveJobInDatabase(
            db,
            resolveCronJobsStorePathFromConfig(cfg, state.env),
            "main",
            kind === "migrated" ? jobId : "another-proactive-job",
            Date.now(),
          );
        });
      }
      const hook = vi.fn(async () => ({
        prependContext: "PROACTIVE-PREPEND",
        appendContext: "PROACTIVE-APPEND",
      }));
      const registry = createMockPluginRegistry([
        { hookName: "heartbeat_prompt_contribution", handler: hook },
      ]);
      initializeGlobalHookRunner(registry);
      preparedRunPluginRegistryMock.mockReturnValue(registry);
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg,
          agentId: "main",
          sessionKey: `cron:${jobId}`,
          job: makeIsolatedAgentJobFixture({
            id: jobId,
            name: "Migrated monitor",
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "Check the retained monitor." },
            delivery: { mode: "none" },
          }),
        }),
      );
      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      const run = runEmbeddedAgentMock.mock.calls[0]?.[0];
      expect(run?.prompt).toContain("Check the retained monitor.");
      if (kind === "migrated") {
        expect(run?.prompt).toContain(
          "PROACTIVE-PREPEND\n\nCheck the retained monitor.\n\nPROACTIVE-APPEND",
        );
        expect(hook).toHaveBeenCalledExactlyOnceWith(
          { agentId: "main", sessionKey: run?.sessionKey, heartbeatName: "Migrated monitor" },
          expect.objectContaining({ agentId: "main", sessionKey: run?.sessionKey }),
        );
      } else {
        expect(run?.prompt).not.toContain("PROACTIVE-PREPEND");
        expect(run?.prompt).not.toContain("PROACTIVE-APPEND");
        expect(hook).not.toHaveBeenCalled();
      }
    });
  },
);
