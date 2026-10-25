import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import * as onboardingPlugins from "../commands/onboarding-plugin-install.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as clawHubSkills from "../infra/clawhub-skills.js";
import * as catalog from "../plugins/official-external-plugin-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import * as skillLifecycle from "../skills/lifecycle/clawhub.js";
import * as recommendationsStore from "../state/onboarding-recommendations.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationMatch,
} from "../state/onboarding-recommendations.js";
import * as recommendations from "../system-agent/setup-app-recommendations.js";
import type { SetupAppRecommendationsResult } from "../system-agent/setup-app-recommendations.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { WizardPrompter } from "./prompts.js";
import { setupAppRecommendations as runAppRecommendations } from "./setup.app-recommendations.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createStore = createOnboardingRecommendationsStore;
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(recommendations, "getSetupAppRecommendations").mockResolvedValue(recommendationResult());
  vi.spyOn(skillLifecycle, "resolveClawHubSkillVerificationTarget").mockResolvedValue({
    ok: false,
    error: "Synthetic skill is not installed",
  });
  vi.spyOn(catalog, "listOfficialExternalPluginCatalogEntries").mockReturnValue([
    {
      name: "@openclaw/chat-plugin",
      openclaw: { plugin: { id: "chat-plugin", label: "Chat plugin" } },
    },
  ]);
});

type SetupFixture = Partial<Parameters<typeof runAppRecommendations>[0]> & {
  platform?: NodeJS.Platform;
  bootstrap?: boolean;
};

async function setupAppRecommendationsWithOutcome(params: SetupFixture) {
  const { bootstrap, platform = "darwin", ...request } = params;
  const workspaceDir = request.workspaceDir ?? tempDirs.make("openclaw-wizard-recommendations-");
  if (bootstrap) {
    writeFileSync(join(workspaceDir, "BOOTSTRAP.md"), "Synthetic bootstrap");
  }
  const runParams = {
    config: {},
    prompter: createPrompter(),
    runtime,
    modelRouteVerified: true,
    ...request,
    workspaceDir,
  };
  // Override only the wizard gate; SQLite workers must keep the real OS identity.
  const platformMock = vi.spyOn(process, "platform", "get").mockReturnValueOnce(platform);
  try {
    return runAppRecommendations(runParams);
  } finally {
    platformMock.mockRestore();
  }
}

function createPrompter(selected: string[] = []): WizardPrompter {
  return createWizardPrompter({
    plain: vi.fn(async () => undefined),
    select: vi.fn(),
    multiselect: vi.fn(async () => selected) as WizardPrompter["multiselect"],
    text: vi.fn(),
    confirm: vi.fn(async () => true),
  });
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

async function fixture(
  initial?: { matches: OnboardingRecommendationMatch[]; answered?: boolean },
  selected: string[] = [],
) {
  const state = await createOpenClawTestState({ label: "wizard-recommendations" });
  onTestFinished(() => state.cleanup());
  const store = createStore({ workspaceDir: state.workspaceDir });
  const record = initial
    ? await store.writeOffer({
        inventory: recommendationResult().apps,
        matches: initial.matches,
        answered: initial.answered ?? false,
        nowMs: 1,
      })
    : null;
  for (const method of [
    "read",
    "writeOffer",
    "acknowledge",
    "updatePending",
    "clearPending",
  ] as const) {
    vi.spyOn(store, method);
  }
  const recommend = vi.mocked(recommendations.getSetupAppRecommendations);
  vi.spyOn(recommendationsStore, "createOnboardingRecommendationsStore").mockReturnValue(store);
  const prompter = createPrompter(selected);
  const runWithOutcome = (params: SetupFixture = {}) =>
    setupAppRecommendationsWithOutcome({ prompter, workspaceDir: state.workspaceDir, ...params });
  const run = async (params: SetupFixture = {}) => {
    const outcome = await runWithOutcome(params);
    await outcome.commitResult();
    return outcome.config;
  };
  return { store, record, recommend, prompter, run, runWithOutcome };
}

function legacySkill() {
  const skill = recommendationResult().matches[1]!;
  return {
    ...skill,
    candidateId: "chat-skill",
    candidate: { ...skill.candidate, id: "chat-skill" },
  };
}

function recommendationResult(): Extract<SetupAppRecommendationsResult, { status: "ok" }> {
  const apps = [{ label: "Chat", bundleId: "com.example.chat" }];
  const match = (
    id: string,
    source: OnboardingRecommendationMatch["candidate"]["source"],
    tier: OnboardingRecommendationMatch["tier"],
  ): OnboardingRecommendationMatch => ({
    appLabel: "Chat",
    candidateId: id,
    tier,
    reason: "Fixture recommendation",
    candidate: { id, displayName: id, summary: "Chat", source },
  });
  const matches = [
    match("chat-plugin", "official-channel", "recommended"),
    match("@demo-owner/chat-skill", "clawhub-skill", "optional"),
  ];
  return { status: "ok", apps, groups: [{ app: apps[0]!, candidates: [] }], matches };
}

describe("setupAppRecommendations", () => {
  it("persists selected installs and completed checkpoints through the worker", async () => {
    await withOpenClawTestState({ label: "recommendation-wizard-worker" }, async (state) => {
      const result = recommendationResult();
      result.matches[1]!.tier = "recommended";
      const store = createOnboardingRecommendationsStore({ workspaceDir: state.workspaceDir });
      const prompter = createPrompter(["recommendation:0", "recommendation:1"]);
      const progress = { update: vi.fn(), stop: vi.fn() };
      vi.mocked(prompter.progress).mockReturnValue(progress);
      const recommend = vi
        .mocked(recommendations.getSetupAppRecommendations)
        .mockImplementation(async ({ onPhase }) => {
          onPhase?.({ kind: "candidates", appCount: 4, sampleLabels: ["alpha", "Bravo", "Echo"] });
          onPhase?.({ kind: "matching", appCount: 4 });
          return result;
        });
      const persistedBeforeInstall: string[][] = [];
      const checkpoint = async () => {
        const pending = await store.read();
        expect(pending?.acceptedAt).toBeNull();
        persistedBeforeInstall.push(pending!.matches.map((match) => match.candidate.id));
      };
      vi.spyOn(onboardingPlugins, "ensureOnboardingPluginInstalled").mockImplementation(
        async ({ cfg }) => {
          await checkpoint();
          return {
            cfg: { ...cfg, plugins: { entries: { "chat-plugin": { enabled: true } } } },
            installed: true,
            pluginId: "chat-plugin",
            status: "installed",
          };
        },
      );
      vi.spyOn(skillLifecycle, "installSkillFromClawHub").mockImplementation(async ({ slug }) => {
        expect(slug).toBe("@demo-owner/chat-skill");
        await checkpoint();
        return {
          ok: true,
          slug: "chat-skill",
          version: "1.0.0",
          targetDir: state.path("synthetic-skill"),
        };
      });
      const outcome = await setupAppRecommendationsWithOutcome({
        prompter,
        workspaceDir: state.workspaceDir,
      });
      expect(prompter.multiselect).toHaveBeenCalledWith(
        expect.objectContaining({ initialValues: ["recommendation:0"] }),
      );
      expect(prompter.plain).toHaveBeenCalledWith(
        "App names are matched with your configured model and ClawHub search (disable via wizard.appRecommendations).",
      );
      expect(vi.mocked(prompter.plain!).mock.invocationCallOrder[0]).toBeLessThan(
        recommend.mock.invocationCallOrder[0]!,
      );
      expect(progress.update.mock.calls).toEqual([
        ["Found 4 apps — searching plugins and skills for alpha, Bravo, Echo…"],
        ["Asking your model to pick the best matches…"],
      ]);
      expect(persistedBeforeInstall).toEqual([
        ["chat-plugin", "@demo-owner/chat-skill"],
        ["chat-plugin", "@demo-owner/chat-skill"],
      ]);
      expect(await store.read()).toMatchObject({
        acceptedAt: null,
        matches: [result.matches[0]],
      });
      await state.writeConfig(outcome.config);
      expect(outcome.config.plugins?.entries?.["chat-plugin"]?.enabled).toBe(true);
      await outcome.commitResult();
      expect(await store.read()).toMatchObject({
        acceptedAt: expect.any(Number),
        matches: [result.matches[0]],
      });
    });
  });

  it.each([
    [{ wizard: { appRecommendations: false } }, "darwin" as const],
    [{}, "linux" as const],
  ])("skips when gated", async (config, platform) => {
    const { recommend, store, run } = await fixture();
    await run({ config, platform });
    expect(recommend).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
  });

  it("short-circuits before scanning when the offer was already answered", async () => {
    const { recommend, prompter, store, run } = await fixture({
      matches: [legacySkill()],
      answered: true,
    });
    await run();
    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.progress).not.toHaveBeenCalled();
    expect(store.writeOffer).not.toHaveBeenCalled();
    expect(store.clearPending).not.toHaveBeenCalled();
  });

  it("rescans a pending offer with a bare ClawHub id", async () => {
    const pendingMatches = recommendationResult().matches;
    pendingMatches[1] = legacySkill();
    const { recommend, store, record, run } = await fixture({ matches: pendingMatches });
    await run();
    expect(store.clearPending).toHaveBeenCalledWith({
      expected: record,
    });
    expect(recommend).toHaveBeenCalledOnce();
  });

  it("leaves a pending stored offer to the bootstrap without rescanning", async () => {
    const { recommend, prompter, store, run } = await fixture({
      matches: recommendationResult().matches,
    });
    await run({ bootstrap: true });
    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    expect(store.writeOffer).not.toHaveBeenCalled();
  });

  it("reoffers a failed install and consumes it after a successful retry", async () => {
    const { store, recommend, prompter, run } = await fixture();
    const installSkill = vi
      .spyOn(skillLifecycle, "installSkillFromClawHub")
      .mockResolvedValueOnce({ ok: false as const, error: "offline" })
      .mockResolvedValueOnce({
        ok: true as const,
        slug: "chat-skill",
        version: "1.0.0",
        targetDir: "/tmp/workspace/skills/chat-skill",
      });
    vi.mocked(prompter.multiselect)
      .mockResolvedValueOnce(["recommendation:1"])
      .mockResolvedValueOnce(["recommendation:0"]);
    await run();

    expect(await store.read()).toMatchObject({
      acceptedAt: null,
      matches: [expect.objectContaining({ candidateId: "@demo-owner/chat-skill" })],
    });

    await run();

    expect(recommend).toHaveBeenCalledOnce();
    expect(installSkill).toHaveBeenCalledTimes(2);
    expect(store.acknowledge).toHaveBeenCalledOnce();
    expect((await store.read())?.acceptedAt).toBeTypeOf("number");
  });

  it("consumes an exact installed skill left pending by an interrupted run", async () => {
    const skill = recommendationResult().matches[1]!;
    const { store, record, runWithOutcome } = await fixture({ matches: [skill] }, [
      "recommendation:0",
    ]);
    const installSkill = vi
      .spyOn(skillLifecycle, "installSkillFromClawHub")
      .mockRejectedValue(new Error("Unexpected skill install"));
    vi.mocked(skillLifecycle.resolveClawHubSkillVerificationTarget).mockResolvedValue({
      ok: true,
      slug: "chat-skill",
      ownerHandle: "demo-owner",
      baseUrl: "https://clawhub.ai",
      version: "1.0.0",
      tag: undefined,
      resolution: {
        source: "installed",
        selector: "installed-version",
        registry: "https://clawhub.ai",
        skillDir: undefined,
        installedVersion: "1.0.0",
      },
    });
    vi.spyOn(clawHubSkills, "fetchClawHubSkillVerification").mockResolvedValue({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: null,
      publisher: null,
      version: null,
      card: null,
      artifact: null,
      provenance: null,
      security: null,
      signature: null,
    });

    const outcome = await runWithOutcome();

    expect(installSkill).not.toHaveBeenCalled();
    expect(store.acknowledge).toHaveBeenCalledWith({
      expected: record,
    });
    await outcome.commitResult();
    expect(store.acknowledge).toHaveBeenCalledOnce();
  });

  it("installs nothing when the explicit skip entry is selected", async () => {
    const ensurePlugin = vi
      .spyOn(onboardingPlugins, "ensureOnboardingPluginInstalled")
      .mockRejectedValue(new Error("Unexpected plugin install"));
    const installSkill = vi
      .spyOn(skillLifecycle, "installSkillFromClawHub")
      .mockRejectedValue(new Error("Unexpected skill install"));
    const config: OpenClawConfig = {};
    const { store, run } = await fixture(undefined, ["__skip__", "recommendation:0"]);

    await expect(run({ config })).resolves.toBe(config);
    expect(ensurePlugin).not.toHaveBeenCalled();
    expect(installSkill).not.toHaveBeenCalled();
    expect(store.writeOffer).toHaveBeenCalledWith(
      expect.objectContaining({ answered: true, matches: recommendationResult().matches }),
    );
  });

  it("stores a pending offer for a fresh workspace bootstrap", async () => {
    const { store, prompter, recommend, run } = await fixture();
    delete prompter.plain;
    const log = vi.fn();
    await run({ bootstrap: true, runtime: { ...runtime, log } });

    expect(store.writeOffer).toHaveBeenCalledWith(
      expect.objectContaining({ answered: false, matches: recommendationResult().matches }),
    );
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "App names are matched with your configured model and ClawHub search (disable via wizard.appRecommendations).",
    );
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(recommend.mock.invocationCallOrder[0]!);
  });
});
