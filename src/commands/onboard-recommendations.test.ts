import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationsRecord,
  type OnboardingRecommendationsStore,
} from "../state/onboarding-recommendations.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  acknowledgeOnboardRecommendationsCommand,
  onboardRecommendationsCommand,
  refreshOnboardRecommendationsCommand,
} from "./onboard-recommendations.js";

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  const loadConfigMock = vi.fn(actual.loadConfig);
  return {
    ...actual,
    loadConfig: loadConfigMock,
    captureRuntimeConfigAsyncReader: () => async () => loadConfigMock(),
  };
});

vi.mock("../state/onboarding-recommendations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/onboarding-recommendations.js")>();
  return {
    ...actual,
    createOnboardingRecommendationsStore: vi.fn(actual.createOnboardingRecommendationsStore),
  };
});

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function chatMatch(): OnboardingRecommendationsRecord["matches"][number] {
  return {
    appLabel: "Chat",
    candidateId: "chat-plugin",
    tier: "recommended",
    reason: "Connects conversations",
    candidate: {
      id: "chat-plugin",
      displayName: "Chat plugin",
      summary: "Chat",
      source: "official-channel",
    },
  };
}

function notesMatch(id = "@demo-owner/notes"): OnboardingRecommendationsRecord["matches"][number] {
  return {
    appLabel: "Notes",
    candidateId: id,
    tier: "optional",
    reason: "Connects notes",
    candidate: { id, displayName: "Notes skill", summary: "Notes", source: "clawhub-skill" },
  };
}

function createOffer(
  overrides: Partial<OnboardingRecommendationsRecord> = {},
): OnboardingRecommendationsRecord {
  return {
    inventoryHash: "hash",
    offeredAt: 1,
    acceptedAt: null,
    updatedAt: 1,
    matches: [chatMatch()],
    ...overrides,
  };
}

describe("onboard recommendations read selection", () => {
  it.each([
    { agent: "   ", error: "--agent must not be blank" },
    { agent: "writer!", error: 'Unknown agent id "writer!"' },
  ])(
    "rejects invalid selector '$agent' without changing the default offer",
    async ({ agent, error }) => {
      await withOpenClawTestState({ label: "recommendation-agent-selection" }, async (state) => {
        await state.writeConfig({
          agents: { entries: { writer: { workspace: state.workspaceDir } } },
        });
        const store = createOnboardingRecommendationsStore({ workspaceDir: state.workspaceDir });
        const offer = await store.writeOffer({
          inventory: [{ label: "Legacy app" }],
          matches: [notesMatch("@demo-owner/legacy-app")],
          answered: false,
          nowMs: 1,
        });

        await expect(
          onboardRecommendationsCommand({ agent, json: true }, makeRuntime()),
        ).rejects.toThrow(error);
        expect(await store.read()).toEqual(offer);
      });
    },
  );
});

describe("onboard recommendations command", () => {
  let store: OnboardingRecommendationsStore;
  let runtime: RuntimeEnv;

  beforeEach(() => {
    runtime = makeRuntime();
    vi.mocked(loadConfig).mockReturnValue({
      agents: { entries: { main: { workspace: "/tmp/onboard-recommendations-test" } } },
    });
    store = {
      read: vi.fn(),
      writeOffer: vi.fn(),
      acknowledge: vi.fn(),
      updatePending: vi.fn(),
      clearPending: vi.fn(),
      clear: vi.fn(),
    };
    vi.mocked(createOnboardingRecommendationsStore).mockReturnValue(store);
  });

  afterEach(() => {
    vi.mocked(loadConfig).mockReset();
    vi.mocked(createOnboardingRecommendationsStore).mockReset();
  });

  it("returns an empty JSON list after the offer was answered", async () => {
    vi.mocked(store.read).mockResolvedValue(createOffer({ acceptedAt: 2, updatedAt: 2 }));

    await onboardRecommendationsCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith("[]");
  });

  it("acknowledges a pending offer", async () => {
    vi.mocked(store.acknowledge).mockResolvedValue(
      createOffer({ acceptedAt: 2, updatedAt: 2, matches: [] }),
    );

    await acknowledgeOnboardRecommendationsCommand({}, runtime);

    expect(store.acknowledge).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith("Onboarding recommendations acknowledged.");
  });

  it("leaves failed bootstrap installs pending and consumes the other matches", async () => {
    const matches = [chatMatch(), notesMatch()];
    vi.mocked(store.read).mockResolvedValue(createOffer({ matches }));
    vi.mocked(store.updatePending).mockResolvedValue(createOffer({ updatedAt: 2, matches: [] }));

    await acknowledgeOnboardRecommendationsCommand({ retry: ["@demo-owner/notes"] }, runtime);

    expect(store.updatePending).toHaveBeenCalledWith({
      matches: [matches[1]],
      expected: createOffer({ matches }),
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Onboarding recommendations updated; 1 left pending for retry.",
    );
  });

  it("rejects unknown bootstrap retry ids without consuming the offer", async () => {
    vi.mocked(store.read).mockResolvedValue(createOffer({ matches: [] }));

    await acknowledgeOnboardRecommendationsCommand({ retry: ["missing-skill"] }, runtime);

    expect(runtime.error).toHaveBeenCalledWith("Unknown pending recommendation id: missing-skill");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(store.acknowledge).not.toHaveBeenCalled();
    expect(store.updatePending).not.toHaveBeenCalled();
  });

  it("fails closed when the pending offer changes before retry persistence", async () => {
    const match = notesMatch();
    vi.mocked(store.read).mockResolvedValue(createOffer({ matches: [match] }));
    vi.mocked(store.updatePending).mockResolvedValue(null);

    await acknowledgeOnboardRecommendationsCommand({ retry: [match.candidateId] }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Stored recommendations changed; read them again before recording retries.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("clears pending bootstrap offers with legacy bare ClawHub ids", async () => {
    vi.mocked(store.read).mockResolvedValue(createOffer({ matches: [notesMatch("notes")] }));
    vi.mocked(store.clearPending).mockResolvedValue(true);

    await onboardRecommendationsCommand({ json: true }, runtime);

    expect(store.clearPending).toHaveBeenCalledWith({
      expected: expect.objectContaining({ inventoryHash: "hash", updatedAt: 1 }),
    });
    expect(runtime.log).toHaveBeenCalledWith("[]");
  });

  it("clears a stored offer for the next onboarding scan", async () => {
    vi.mocked(store.clear).mockResolvedValue(true);

    await refreshOnboardRecommendationsCommand({}, runtime);

    expect(store.clear).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith(
      "Onboarding recommendations cleared. The next onboarding run will rescan.",
    );
  });

  it("drops unsafe install identifiers from the bootstrap payload", async () => {
    vi.mocked(store.read).mockResolvedValue(
      createOffer({ matches: [notesMatch("skill;curl-evil")] }),
    );

    await onboardRecommendationsCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith("[]");
  });

  it("deduplicates shared candidates and keeps the recommended tier", async () => {
    const match = chatMatch();
    vi.mocked(store.read).mockResolvedValue(
      createOffer({
        matches: [
          { ...match, tier: "optional" },
          { ...match, appLabel: "Work Chat", reason: "Connects work conversations" },
        ],
      }),
    );

    await onboardRecommendationsCommand({ json: true }, runtime);

    const output = vi.mocked(runtime.log).mock.calls[0]?.[0];
    expect(JSON.parse(output as string)).toEqual([
      { id: "chat-plugin", source: "official-plugin", tier: "recommended" },
    ]);
    expect(output).not.toContain("Connects conversations");
    expect(output).not.toContain("Chat plugin");
  });
});
