import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { clearConfigCache, readConfigFileSnapshot as readSnapshot } from "../config/config.js";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import * as proactive from "../cron/default-proactive-job.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { describeSetupFirstAgent } from "./setup-first-agent.js";
import { fixture, modelRef } from "./setup-inference-activate.test-support.js";
import { resetSetupInferenceState } from "./setup-inference-state.test-support.js";

afterEach(async () => {
  resetConfigRuntimeState();
  await resetSetupInferenceState();
});

it.each([
  "success",
  "existing",
  "consent-rejected",
  "probe-failure",
  "cancelled",
  "application-failure",
])(
  "couples canonical first-agent creation with host-only Codex activation (%s)",
  async (outcome) => {
    const setup = await fixture({
      codex: true,
      homeScope: "user",
      fresh: outcome !== "existing",
      skipBootstrap: false,
      surface: "gateway",
    });
    const provision = vi.spyOn(proactive, "provisionDefaultProactiveJob");
    if (outcome === "existing") {
      setup.config.agents!.entries!.main = { name: "Existing agent", workspace: setup.workspace };
      await fs.writeFile(setup.configPath, JSON.stringify(setup.config));
      clearConfigCache();
    }
    const controller = new AbortController();
    const withApplication = outcome === "success" || outcome === "application-failure";
    let applicationCount = 0;
    if (withApplication) {
      const initial = await readSnapshot();
      setRuntimeConfigSnapshot(initial.config, initial.sourceConfig);
      onTestFinished(
        registerConfigWriteListener(
          (event) => {
            const claim = getRuntimeConfigWriteApplication(event)?.claim();
            assert(claim, "Canonical creation must preserve the setup application receipt");
            const first = applicationCount++ === 0;
            const failed = outcome === "application-failure" && first;
            void Promise.resolve(claim.prepare?.(() => {})).then(() => {
              if (!failed) {
                setRuntimeConfigSnapshot(event.runtimeConfig, event.sourceConfig);
              }
              claim.settle(failed ? "failed" : "applied");
            });
          },
          {
            ownsRuntimeActivationFor: setup.configPath,
            preCommitRuntimePreflight: async (sourceConfig) => ({
              runtimeConfig: sourceConfig,
              compareConfig: sourceConfig,
            }),
          },
        ),
      );
    }
    const harness = setup.pluginRegistry.agentHarnesses[0]!.harness;
    harness.executionEnvironment = "host-only";
    harness.verifySetup = async () => {
      if (outcome === "probe-failure") {
        throw new Error("Native verification refused");
      }
      if (outcome === "cancelled") {
        controller.abort();
      }
    };
    if (outcome === "consent-rejected") {
      vi.mocked(setup.prompter.select).mockRejectedValue(new WizardCancelledError());
    } else {
      vi.mocked(setup.prompter.select).mockResolvedValue("continue");
    }
    let complete: (() => Promise<boolean>) | undefined;
    const activation = setup.activate("codex-cli", undefined, {
      agentId: "main",
      signal: controller.signal,
      ...(withApplication
        ? {
            onActivationCompletion: (completion: () => Promise<boolean>) => {
              complete = completion;
            },
          }
        : {}),
    });
    if (outcome === "consent-rejected") {
      await expect(activation).rejects.toBeInstanceOf(WizardCancelledError);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      expect(provision).not.toHaveBeenCalled();
      return;
    }
    const result = await activation;
    if (outcome === "probe-failure" || outcome === "cancelled") {
      expect(result).toMatchObject({ ok: false });
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      expect(provision).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ ok: true });
    if (outcome === "application-failure") {
      expect(complete).toBeTypeOf("function");
      await expect(complete!()).rejects.toThrow("did not complete activation (failed)");
      const restored = await readSnapshot();
      expect(restored.sourceConfigBeforeMigrations?.agents).toEqual(setup.config.agents);
      expect(hasResolvedRosterBeforeMigrations(restored)).toBe(false);
      expect(restored.sourceConfig.agents?.defaults?.model).toBeUndefined();
      expect(provision).not.toHaveBeenCalled();
      expect(applicationCount).toBe(2);
      return;
    }
    if (complete) {
      await expect(complete()).resolves.toBe(false);
      expect(applicationCount).toBe(1);
    }
    const described = await describeSetupFirstAgent({ agentId: "main" });
    const snapshot = await readSnapshot();
    if (outcome === "existing") {
      expect(snapshot.sourceConfig.agents?.entries?.main).toMatchObject({
        name: "Existing agent",
        workspace: setup.workspace,
        model: modelRef,
        nativeRuntimeConsent: ["codex"],
      });
      expect(Object.keys(snapshot.sourceConfig.agents?.entries ?? {})).toEqual(["main"]);
      await expect(fs.stat(path.join(setup.workspace, "BOOTSTRAP.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(described).toEqual({
        agentId: "main",
        sessionKey: "agent:main:main",
        bootstrapPending: false,
      });
      expect(provision).not.toHaveBeenCalled();
      return;
    }
    expect(snapshot.sourceConfig.agents?.entries?.main).toMatchObject({
      name: "main",
      workspace: setup.workspace,
      nativeRuntimeConsent: ["codex"],
    });
    expect(snapshot.sourceConfig.gateway).toEqual(setup.config.gateway);
    expect(snapshot.sourceConfig.tools).toEqual(setup.config.tools);
    expect(await fs.readFile(path.join(setup.workspace, "BOOTSTRAP.md"), "utf8")).toContain(
      "The user's request always comes first.",
    );
    expect(provision).toHaveBeenCalledOnce();
    expect(described).toEqual({
      agentId: "main",
      sessionKey: "agent:main:main",
      bootstrapPending: true,
    });
  },
);
