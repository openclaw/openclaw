import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as onboardingPlugins from "../commands/onboarding-plugin-install.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as clawHubSkills from "../infra/clawhub-skills.js";
import * as catalog from "../plugins/official-external-plugin-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import * as skillLifecycle from "../skills/lifecycle/clawhub.js";
import * as recommendationsStore from "../state/onboarding-recommendations.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationsRecord,
  type OnboardingRecommendationsStore,
} from "../state/onboarding-recommendations.js";
import * as recommendations from "../system-agent/setup-app-recommendations.js";
import type {
  SetupAppRecommendationsResult,
  SetupAppScanPhase,
} from "../system-agent/setup-app-recommendations.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { WizardPrompter } from "./prompts.js";
import { setupAppRecommendations as runAppRecommendations } from "./setup.app-recommendations.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createStore = createOnboardingRecommendationsStore;
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
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
  deps?: {
    recommend?: (
      onPhase?: (phase: SetupAppScanPhase) => void,
    ) => Promise<SetupAppRecommendationsResult>;
    ensurePlugin?: typeof onboardingPlugins.ensureOnboardingPluginInstalled;
    installSkill?: typeof skillLifecycle.installSkillFromClawHub;
    readStored?: OnboardingRecommendationsStore["read"];
    writeOffer?: OnboardingRecommendationsStore["writeOffer"];
    acknowledgeStored?: OnboardingRecommendationsStore["acknowledge"];
    updatePendingStored?: OnboardingRecommendationsStore["updatePending"];
    clearPendingStored?: OnboardingRecommendationsStore["clearPending"];
    deferOfferToBootstrap?: () => boolean;
  };
};

async function setupAppRecommendationsWithOutcome(params: SetupFixture) {
  const { deps = {}, platform = "darwin", ...request } = params;
  const workspaceDir = request.workspaceDir ?? tempDirs.make("openclaw-wizard-recommendations-");
  if (deps.deferOfferToBootstrap?.()) {
    writeFileSync(join(workspaceDir, "BOOTSTRAP.md"), "Synthetic bootstrap");
  }
  if (deps.recommend) {
    const recommend = deps.recommend;
    vi.spyOn(recommendations, "getSetupAppRecommendations").mockImplementation(({ onPhase }) =>
      recommend(onPhase),
    );
  }
  if (deps.ensurePlugin) {
    vi.spyOn(onboardingPlugins, "ensureOnboardingPluginInstalled").mockImplementation(
      deps.ensurePlugin,
    );
  }
  if (deps.installSkill) {
    vi.spyOn(skillLifecycle, "installSkillFromClawHub").mockImplementation(deps.installSkill);
  }
  vi.spyOn(recommendationsStore, "createOnboardingRecommendationsStore").mockImplementation(
    (options) => {
      const store = createStore(options);
      return {
        ...store,
        read: deps.readStored ?? store.read,
        writeOffer: deps.writeOffer ?? store.writeOffer,
        acknowledge: deps.acknowledgeStored ?? store.acknowledge,
        updatePending: deps.updatePendingStored ?? store.updatePending,
        clearPending: deps.clearPendingStored ?? store.clearPending,
      };
    },
  );
  return await withMockedPlatform(platform, () =>
    runAppRecommendations({
      config: {},
      prompter: createPrompter(),
      runtime,
      modelRouteVerified: true,
      ...request,
      workspaceDir,
    }),
  );
}

async function setupAppRecommendations(params: SetupFixture): Promise<OpenClawConfig> {
  const outcome = await setupAppRecommendationsWithOutcome(params);
  await outcome.commitResult();
  return outcome.config;
}

function createPrompter(selected: string[] = []): WizardPrompter {
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    plain: vi.fn(async () => undefined),
    select: vi.fn(),
    multiselect: vi.fn(async () => selected) as WizardPrompter["multiselect"],
    text: vi.fn(),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function storeDeps(initial: OnboardingRecommendationsRecord | null = null) {
  let current = initial;
  let now = 0;
  const writeOffer = vi.fn(
    async (params: Parameters<OnboardingRecommendationsStore["writeOffer"]>[0]) => {
      now += 1;
      current = {
        inventoryHash: "hash",
        matches: [...params.matches],
        offeredAt: now,
        acceptedAt: params.answered ? now : null,
        updatedAt: now,
      };
      return current;
    },
  );
  const acknowledgeStored = vi.fn(
    async (params: Parameters<OnboardingRecommendationsStore["acknowledge"]>[0] = {}) => {
      if (
        !current ||
        (params.expected &&
          (params.expected.inventoryHash !== current.inventoryHash ||
            params.expected.updatedAt !== current.updatedAt))
      ) {
        return null;
      }
      now += 1;
      current = { ...current, acceptedAt: now, updatedAt: now };
      return current;
    },
  );
  const updatePendingStored = vi.fn(
    async (params: Parameters<OnboardingRecommendationsStore["updatePending"]>[0]) => {
      if (
        !current ||
        params.expected.inventoryHash !== current.inventoryHash ||
        params.expected.updatedAt !== current.updatedAt
      ) {
        return null;
      }
      now += 1;
      current = { ...current, matches: [...params.matches], updatedAt: now };
      return current;
    },
  );
  return {
    readStored: vi.fn(async (): Promise<OnboardingRecommendationsRecord | null> => current),
    writeOffer,
    acknowledgeStored,
    updatePendingStored,
    deferOfferToBootstrap: vi.fn(() => false),
  };
}

function recommendationResult(): Extract<SetupAppRecommendationsResult, { status: "ok" }> {
  const apps = [{ label: "Chat", bundleId: "com.example.chat" }];
  const matches = [
    {
      appLabel: "Chat",
      candidateId: "chat-plugin",
      tier: "recommended" as const,
      reason: "Connects conversations",
      candidate: {
        id: "chat-plugin",
        displayName: "Chat plugin",
        summary: "Chat",
        source: "official-channel" as const,
      },
    },
    {
      appLabel: "Chat",
      candidateId: "@demo-owner/chat-skill",
      tier: "optional" as const,
      reason: "Adds useful actions",
      candidate: {
        id: "@demo-owner/chat-skill",
        displayName: "Chat skill",
        summary: "Chat skill",
        source: "clawhub-skill" as const,
      },
    },
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
      const recommend = vi.fn(async (onPhase?: (phase: SetupAppScanPhase) => void) => {
        onPhase?.({ kind: "candidates", appCount: 4, sampleLabels: ["alpha", "Bravo", "Echo"] });
        onPhase?.({ kind: "matching", appCount: 4 });
        return result;
      });
      const persistedBeforeInstall: string[][] = [];
      const outcome = await setupAppRecommendationsWithOutcome({
        config: {},
        prompter,
        runtime,
        workspaceDir: state.workspaceDir,
        modelRouteVerified: true,
        platform: "darwin",
        deps: {
          recommend,
          deferOfferToBootstrap: () => false,
          ensurePlugin: async ({ cfg }) => {
            const pending = await store.read();
            expect(pending?.acceptedAt).toBeNull();
            persistedBeforeInstall.push(pending!.matches.map((match) => match.candidate.id));
            return {
              cfg: { ...cfg, plugins: { entries: { "chat-plugin": { enabled: true } } } },
              installed: true,
              pluginId: "chat-plugin",
              status: "installed",
            };
          },
          installSkill: async ({ slug }) => {
            expect(slug).toBe("@demo-owner/chat-skill");
            const pending = await store.read();
            expect(pending?.acceptedAt).toBeNull();
            persistedBeforeInstall.push(pending!.matches.map((match) => match.candidate.id));
            return {
              ok: true,
              slug: "chat-skill",
              version: "1.0.0",
              targetDir: state.path("synthetic-skill"),
            };
          },
        },
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
    const recommend = vi.fn(async () => recommendationResult());
    const store = storeDeps();
    await setupAppRecommendations({
      config,
      platform,
      deps: { recommend, ...store },
    });
    expect(recommend).not.toHaveBeenCalled();
    expect(store.readStored).not.toHaveBeenCalled();
  });

  it("short-circuits before scanning when the offer was already answered", async () => {
    const recommend = vi.fn(async () => recommendationResult());
    const writeOffer = vi.fn();
    const clearPendingStored = vi.fn();
    const prompter = createPrompter();
    const legacyMatch = recommendationResult().matches[1]!;

    await setupAppRecommendations({
      prompter,
      deps: {
        recommend,
        writeOffer,
        clearPendingStored,
        readStored: async () => ({
          inventoryHash: "hash",
          matches: [
            {
              ...legacyMatch,
              candidateId: "chat-skill",
              candidate: { ...legacyMatch.candidate, id: "chat-skill" },
            },
          ],
          offeredAt: 1,
          acceptedAt: 2,
          updatedAt: 2,
        }),
      },
    });

    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.progress).not.toHaveBeenCalled();
    expect(writeOffer).not.toHaveBeenCalled();
    expect(clearPendingStored).not.toHaveBeenCalled();
  });

  it("rescans a pending offer with a bare ClawHub id", async () => {
    const pendingMatches = recommendationResult().matches;
    pendingMatches[1] = {
      ...pendingMatches[1]!,
      candidateId: "chat-skill",
      candidate: { ...pendingMatches[1]!.candidate, id: "chat-skill" },
    };
    const recommend = vi.fn(async () => recommendationResult());
    const clearPendingStored = vi.fn(async () => true);

    await setupAppRecommendations({
      deps: {
        recommend,
        readStored: async () => ({
          inventoryHash: "hash",
          matches: pendingMatches,
          offeredAt: 1,
          acceptedAt: null,
          updatedAt: 1,
        }),
        writeOffer: vi.fn(),
        clearPendingStored,
        deferOfferToBootstrap: () => false,
      },
    });

    expect(clearPendingStored).toHaveBeenCalledWith({
      expected: expect.objectContaining({ inventoryHash: "hash", updatedAt: 1 }),
    });
    expect(recommend).toHaveBeenCalledOnce();
  });

  it("leaves a pending stored offer to the bootstrap without rescanning", async () => {
    const recommend = vi.fn(async () => recommendationResult());
    const writeOffer = vi.fn();
    const prompter = createPrompter();

    await setupAppRecommendations({
      prompter,
      deps: {
        recommend,
        writeOffer,
        readStored: async () => ({
          inventoryHash: "hash",
          matches: recommendationResult().matches,
          offeredAt: 1,
          acceptedAt: null,
          updatedAt: 1,
        }),
        deferOfferToBootstrap: () => true,
      },
    });

    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    expect(writeOffer).not.toHaveBeenCalled();
  });

  it("reoffers a failed install and consumes it after a successful retry", async () => {
    const store = storeDeps();
    const recommend = vi.fn(async () => recommendationResult());
    const installSkill = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "offline" })
      .mockResolvedValueOnce({
        ok: true as const,
        slug: "chat-skill",
        version: "1.0.0",
        targetDir: "/tmp/workspace/skills/chat-skill",
      });
    const prompter = createPrompter();
    vi.mocked(prompter.multiselect)
      .mockResolvedValueOnce(["recommendation:1"])
      .mockResolvedValueOnce(["recommendation:0"]);
    const deps = { recommend, installSkill, ...store };

    await setupAppRecommendations({
      prompter,
      deps,
    });

    expect(await store.readStored()).toMatchObject({
      acceptedAt: null,
      matches: [expect.objectContaining({ candidateId: "@demo-owner/chat-skill" })],
    });

    await setupAppRecommendations({
      prompter,
      deps,
    });

    expect(recommend).toHaveBeenCalledOnce();
    expect(installSkill).toHaveBeenCalledTimes(2);
    expect(store.acknowledgeStored).toHaveBeenCalledOnce();
    expect((await store.readStored())?.acceptedAt).toBeTypeOf("number");
  });

  it("consumes an exact installed skill left pending by an interrupted run", async () => {
    const skill = recommendationResult().matches[1]!;
    const stored: OnboardingRecommendationsRecord = {
      inventoryHash: "hash",
      matches: [skill],
      offeredAt: 1,
      acceptedAt: null,
      updatedAt: 1,
    };
    const store = storeDeps(stored);
    const installSkill = vi.fn();
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

    const outcome = await setupAppRecommendationsWithOutcome({
      config: {},
      prompter: createPrompter(["recommendation:0"]),
      runtime,
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        ...store,
        installSkill,
      },
    });

    expect(installSkill).not.toHaveBeenCalled();
    expect(store.acknowledgeStored).toHaveBeenCalledWith({
      expected: expect.objectContaining({ matches: [skill], updatedAt: 1 }),
    });
    await outcome.commitResult();
    expect(store.acknowledgeStored).toHaveBeenCalledOnce();
  });

  it("installs nothing when the explicit skip entry is selected", async () => {
    const ensurePlugin = vi.fn();
    const installSkill = vi.fn();
    const config: OpenClawConfig = {};
    const store = storeDeps();

    await expect(
      setupAppRecommendations({
        config,
        prompter: createPrompter(["__skip__", "recommendation:0"]),
        deps: {
          ...store,
          recommend: async () => recommendationResult(),
          ensurePlugin,
          installSkill,
        },
      }),
    ).resolves.toBe(config);
    expect(ensurePlugin).not.toHaveBeenCalled();
    expect(installSkill).not.toHaveBeenCalled();
    expect(store.writeOffer).toHaveBeenCalledWith(
      expect.objectContaining({ answered: true, matches: recommendationResult().matches }),
    );
  });

  it("stores a pending offer for a fresh workspace bootstrap", async () => {
    const store = storeDeps();
    store.deferOfferToBootstrap.mockReturnValue(true);
    const prompter = createPrompter();
    delete prompter.plain;
    const log = vi.fn();
    const recommend = vi.fn(async () => recommendationResult());

    await setupAppRecommendations({
      prompter,
      runtime: { ...runtime, log },
      deps: { recommend, ...store },
    });

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
