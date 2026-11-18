import { afterEach, expect, it, vi } from "vitest";
import { resolveAllowedModelRefCore } from "../agents/model-selection-resolve.js";
import { resolveConfiguredModelRef } from "../agents/model-selection-shared.js";
import { retireHeartbeatWithDoctor } from "../commands/doctor-heartbeat-retirement.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeIsolatedAgentParamsFixture } from "./isolated-agent/job-fixtures.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePathFromConfig,
} from "./store.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
afterEach(() => vi.restoreAllMocks());

it("executes a migrated heartbeat on its allowed default and rejects an ordinary forbidden override", () =>
  withOpenClawTestState({ prefix: "openclaw-heartbeat-run-" }, async (state) => {
    resetRunCronIsolatedAgentTurnHarness();
    // Keep the ordinary execution harness's provider/session fixtures, but use real model policy.
    resolveConfiguredModelRefMock.mockImplementation(resolveConfiguredModelRef);
    resolveAllowedModelRefMock.mockImplementation(resolveAllowedModelRefCore);
    mockRunCronFallbackPassthrough();
    const workspace = state.workspaceDir;
    ensureAgentWorkspaceMock.mockResolvedValue({ dir: workspace });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          modelPolicy: { allow: ["openai/gpt-5.4"] },
          heartbeat: { model: "openai/gpt-4o-mini", isolatedSession: true, target: "none" },
        },
        entries: { main: { workspace } },
      },
    };
    const next = await withPluginMetadataSnapshotScope(createPluginMetadataSnapshotFixture(), () =>
      retireHeartbeatWithDoctor(cfg),
    );
    const {
      store: { jobs },
    } = await loadCronJobsStoreWithConfigJobsReadOnly(resolveCronJobsStorePathFromConfig(next));
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.payload).not.toHaveProperty("model");
    const params = makeIsolatedAgentParamsFixture({
      cfg: next,
      job,
      agentId: "main",
      message: "Check the synthetic monitor.",
      sessionKey: `cron:${job.id}`,
      lane: "cron",
    });
    const result = await runCronIsolatedAgentTurn(params);
    expect(result).toMatchObject({ status: "ok", provider: "openai", model: "gpt-5.4" });

    runEmbeddedAgentMock.mockClear();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
    const rejected = await runCronIsolatedAgentTurn({
      ...params,
      sessionKey: "cron:ordinary-forbidden-override",
      job: {
        ...job,
        id: "ordinary-forbidden-override",
        payload: { kind: "agentTurn", message: "Ordinary override", model: "openai/gpt-4o-mini" },
      },
    });
    expect(rejected).toMatchObject({
      status: "error",
      error: expect.stringContaining("rejected by agents.defaults.modelPolicy.allow"),
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(next.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.4"] });
  }));
