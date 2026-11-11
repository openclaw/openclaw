import { expect, it, vi } from "vitest";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import * as transcriptPreparation from "../agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import {
  changeAccount,
  completedResponse,
  configure,
  installCronAuthContinuityHooks,
  interceptProvider,
  keyProfile,
  platformId,
  platformKey,
  provider,
  quotaResponse,
  requestedModel,
  runStoredTurn,
  runtimeModels,
  storedJob,
  withAuthState,
  writeConfig,
} from "./isolated-agent.auth-continuity.test-support.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

installCronAuthContinuityHooks();

it.each(
  (["isolated", "session:agent:main:authority"] as const).flatMap((sessionTarget) =>
    ["configured-key", "credentialless"].flatMap((credential) =>
      ["healthy", "revoked", "replaced"].map((change) => ({ sessionTarget, credential, change })),
    ),
  ),
)(
  "retains original authority: $sessionTarget $credential $change",
  async ({ sessionTarget, credential, change }) => {
    await withAuthState("cron-unbound-fallback-authority", async (state) => {
      const requests: Array<{ model: string; auth: string | null }> = [];
      let preparedFallback = false;
      interceptProvider(async (input, init) => {
        const request = new Request(input, init);
        const model = await requestedModel(request);
        requests.push({ model, auth: request.headers.get("authorization") });
        if (request.url === "https://api.openai.com/v1/responses") {
          return quotaResponse();
        }
        if (request.url === "http://127.0.0.1:11434/v1/responses") {
          return completedResponse(model);
        }
        throw new Error("Unexpected I/O: " + request.url);
      });
      await persistAuthProfileBatch({ profiles: [keyProfile(platformId, platformKey)] });
      const cfg = configure(
        state,
        {
          model: { primary: "openai/gpt-4.1", fallbacks: ["local/gpt-4o"] },
          models: runtimeModels("openai/gpt-4.1", "local/gpt-4o"),
        },
        {
          openai: provider("https://api.openai.com/v1"),
          local: {
            ...provider("http://127.0.0.1:11434/v1", "openai-responses", ["gpt-4o"]),
            ...(credential === "configured-key" ? { apiKey: "synthetic-local-config-key" } : {}),
          },
        },
        { profiles: { [platformId]: { provider: "openai", mode: "api_key" } } },
      );
      await writeConfig(state, cfg);
      const binding = await captureCronInferenceBinding({ cfg, agentId: "main" });
      expect(binding?.profileId).toBe(platformId);
      const job: CronStoredJob = {
        ...storedJob("unbound-fallback-authority"),
        sessionTarget,
        inferenceBinding: binding ?? undefined,
      };
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const prepare = transcriptPreparation.prepareEmbeddedAttemptTranscriptLifecycle;
      vi.spyOn(
        transcriptPreparation,
        "prepareEmbeddedAttemptTranscriptLifecycle",
      ).mockImplementation(async (params) => {
        const prepared = await prepare(params);
        // Change real account ownership after the fallback's native awaited preparation,
        // not before candidate admission. The final serialized effect must still refuse it.
        if (requests.length === 1 && !preparedFallback) {
          preparedFallback = true;
          if (change !== "healthy") {
            await changeAccount(platformId, change === "replaced");
          }
        }
        return prepared;
      });
      const result = await runStoredTurn(cfg, (await loadCronJobsStore(storePath)).jobs[0]!);
      expect(preparedFallback).toBe(true);
      expect((await loadCronJobsStore(storePath)).jobs[0]).toEqual(job);
      expect(requests.map((request) => request.model)).toEqual(
        change === "healthy" ? ["gpt-4.1", "gpt-4o"] : ["gpt-4.1"],
      );
      expect(result.status, result.error).toBe(change === "healthy" ? "ok" : "error");
      if (change !== "healthy") {
        if (sessionTarget === "isolated") {
          expect(result.error).toMatch(/disconnected|replaced|authority is no longer active/i);
        } else {
          expect(result.error).toBe("Session event execution failed");
        }
      } else if (credential === "configured-key") {
        expect(requests[1]?.auth).toBe("Bearer synthetic-local-config-key");
      }
    });
  },
);
