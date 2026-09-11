import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { collectConfiguredProviderUseSelections } from "../../../agents/configured-provider-selection-ids.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronJobsStorePathFromConfig, saveCronJobsStore } from "../../../cron/store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";

it.each([
  "agents.defaults.subagents.model",
  "agents.entries.alpha.subagents.model",
  "agents.defaults.utilityModel",
  "agents.defaults.imageModel",
  "agents.defaults.pdfModel",
  "agents.defaults.voiceModel",
  "agents.defaults.mediaModels.image",
  "agents.defaults.mediaModels.video",
  "agents.defaults.mediaModels.music",
  "agents.defaults.heartbeat.model",
  "agents.defaults.compaction.model",
  "agents.defaults.compaction.memoryFlush.model",
  "tools.exec.reviewer.model",
  "agents.entries.alpha.tools.exec.reviewer.model",
  "channels.modelByChannel.discord.channel",
])("collects the executable selection at %s", async (selector) => {
  await withOpenClawTestState({ label: "provider-selection" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "openai/unrelated" }, entries: { alpha: {} } },
    };
    let target: unknown = config;
    const fields = selector.split(".");
    for (const field of fields.slice(0, -1)) {
      assert(isRecord(target));
      target[field] ??= {};
      target = target[field];
    }
    assert(isRecord(target));
    target[fields.at(-1)!] = "byteplus-plan/ark-code-latest";
    expect(collectConfiguredProviderUseSelections({ config, env: state.env })).toContainEqual({
      agentId: "alpha",
      provider: "byteplus-plan",
      previouslyCovered: false,
    });
  });
});

it("resolves selected aliases per agent without enrolling catalog-only siblings", async () => {
  await withOpenClawTestState({ label: "provider-selection-alias" }, async (state) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/unrelated", fallbacks: ["anthropic/fallback"] },
          subagents: { model: "plan" },
          models: {
            "byteplus-plan/ark-code-latest": { alias: "plan" },
            "volcengine-plan/ark-code-latest": {},
          },
        },
        entries: {
          alpha: { model: "openai/alpha" },
          beta: { subagents: { model: "openai/beta-child" } },
        },
      },
    };
    const selected = collectConfiguredProviderUseSelections({ config, env: state.env });
    expect(selected).toContainEqual({
      agentId: "alpha",
      provider: "byteplus-plan",
      previouslyCovered: false,
    });
    expect(selected).not.toContainEqual({
      agentId: "alpha",
      provider: "anthropic",
      previouslyCovered: true,
    });
    expect(selected).toContainEqual({
      agentId: "beta",
      provider: "anthropic",
      previouslyCovered: true,
    });
    expect(
      selected.some(
        (selection) => selection.agentId === "beta" && selection.provider === "byteplus-plan",
      ),
    ).toBe(false);
    expect(selected.some((selection) => selection.provider === "volcengine-plan")).toBe(false);
  });
});

it("reads a persisted cron model and fallbacks in the job's agent scope", async () => {
  await withOpenClawTestState({ label: "provider-selection-cron" }, async (state) => {
    const config: OpenClawConfig = { agents: { entries: { alpha: {}, beta: {} } } };
    await saveCronJobsStore(resolveCronJobsStorePathFromConfig(config, state.env), {
      version: 1,
      jobs: [
        {
          id: "selected-job",
          name: "Selected job",
          enabled: true,
          agentId: "beta",
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: "fixture",
            model: "byteplus-plan/ark-code-latest",
            fallbacks: ["volcengine-plan/ark-code-latest"],
          },
          state: {},
        },
      ],
    });
    const selected = collectConfiguredProviderUseSelections({ config, env: state.env });
    expect(selected).toContainEqual({
      agentId: "beta",
      provider: "byteplus-plan",
      previouslyCovered: false,
    });
    expect(selected).toContainEqual({
      agentId: "beta",
      provider: "volcengine-plan",
      previouslyCovered: false,
    });
    expect(selected.some((selection) => selection.agentId === "alpha")).toBe(false);
  });
});
