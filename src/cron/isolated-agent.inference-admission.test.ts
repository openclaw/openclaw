import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { runFallbackModelAttempt } from "../agents/test-helpers/model-fallback-runner.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import * as h from "./isolated-agent/run.test-harness.js";
import type { CronStoredJob } from "./types.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
// Capture uses the same scheduled-model selector installed by the run harness.
const { captureCronInferenceBinding } = await import("./inference-binding.runtime.js");
const platformId = "openai:platform";
const subscriptionId = "openai:subscription";
const capture = (cfg: OpenClawConfig, model: string) =>
  captureCronInferenceBinding({ cfg, agentId: "main", model });
const makeAuthJob = (overrides: Partial<CronStoredJob>): CronStoredJob =>
  makeIsolatedAgentJobFixture({ agentId: "main", delivery: { mode: "none" }, ...overrides });
const runWithConfig = (cfg: OpenClawConfig, job: CronStoredJob) =>
  runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({ cfg, job, sessionKey: "cron:job-1", lane: "cron" }),
  );

describe("cron inference admission", () => {
  setupRunCronIsolatedAgentTurnSuite();
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "cron-inference-admission",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    });
    vi.mocked(resolveAgentDir).mockReturnValue(state.agentDir());
    h.loadModelCatalogOwnerMock.mockImplementation(async ({ config, agentId = "main" }) => ({
      agentId,
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config,
      modelCatalog: { entries: [], routeVariants: [] },
    }));
    h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
    h.resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-4.1" } });
    h.mockRunCronFallbackPassthrough();
    await persistAuthProfileBatch({
      profiles: [
        {
          profileId: platformId,
          credential: { type: "api_key", provider: "openai", key: "synthetic-platform-key" },
        },
        {
          profileId: subscriptionId,
          credential: {
            type: "oauth",
            provider: "openai",
            access: "synthetic-subscription-access",
            refresh: "synthetic-subscription-refresh",
            expires: Date.now() + 3_600_000,
            accountId: "synthetic-account",
          },
        },
      ],
    });
    cfg = {
      agents: {
        entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
        defaults: { model: "openai/gpt-4.1" },
      },
      auth: {
        profiles: {
          [platformId]: { provider: "openai", mode: "api_key" },
          [subscriptionId]: { provider: "openai", mode: "oauth" },
        },
        order: { openai: [platformId, subscriptionId] },
      },
    };
  });
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  });

  it("freezes authored account policy before asynchronous preparation", async () => {
    const binding = await capture(cfg, `openai/gpt-4.1@${platformId}`);
    if (!binding) {
      throw new Error("Expected stored account");
    }
    const alternate = { ...binding };
    const job = makeAuthJob({
      payload: {
        kind: "agentTurn",
        message: "original",
        model: "openai/gpt-4.1",
        fallbacks: ["openai/gpt-4o"],
      },
      inferenceBinding: { ...binding },
      inferenceGrants: { "openai/gpt-4o": alternate },
    });
    h.loadPublishedReplyDispatchRuntimeMock.mockImplementationOnce(async () => {
      if (job.payload.kind !== "agentTurn") {
        throw new Error("Expected agent job");
      }
      job.payload.model = "openai/gpt-4o";
      job.payload.fallbacks!.splice(0);
      job.inferenceBinding!.profileId = subscriptionId;
      alternate.profileId = subscriptionId;
      return undefined;
    });
    h.runWithModelFallbackMock.mockImplementationOnce(async (params) => {
      expect(params).toMatchObject({ model: "gpt-4.1", fallbacksOverride: ["openai/gpt-4o"] });
      // Deliberately omit eager admission: dispatch must still acquire the frozen alternate.
      return {
        result: await runFallbackModelAttempt(params, "openai", "gpt-4o", "rate_limit"),
        provider: "openai",
        model: "gpt-4o",
        attempts: [],
      };
    });
    const result = await runWithConfig(cfg, job);
    expect(result.status, result.error).toBe("ok");
    expect(h.runEmbeddedAgentMock.mock.lastCall?.[0]).toMatchObject({
      model: "gpt-4o",
      authProfileId: platformId,
      authProfileBinding: { profileId: platformId },
      allowAuthProfileFallback: false,
    });
  });

  it("refuses an unapproved candidate even when eager admission is omitted", async () => {
    const binding = await capture(cfg, `openai/gpt-4.1@${platformId}`);
    h.runWithModelFallbackMock.mockImplementationOnce(async (params) => ({
      result: await runFallbackModelAttempt(params, "openai", "gpt-4o", "rate_limit"),
      provider: "openai",
      model: "gpt-4o",
      attempts: [],
    }));
    const result = await runWithConfig(
      cfg,
      makeAuthJob({ inferenceBinding: binding ?? undefined, inferenceGrants: {} }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("no recorded account authorization");
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(h.runCliAgentMock).not.toHaveBeenCalled();
  });
});
