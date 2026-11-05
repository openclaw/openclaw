import { beforeEach, expect, it, vi } from "vitest";
import { runCodexSessionRouteHealth } from "./doctor-health-contribution-runners.state.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "./doctor-health-contributions.test-support.js";

const mocks = vi.hoisted(() => ({
  maybeRepairCodexSessionRoutes: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../commands/doctor/shared/codex-route-warnings.js", () => ({
  maybeRepairCodexSessionRoutes: mocks.maybeRepairCodexSessionRoutes,
}));

// mock-isolation: capture migration notes without rendering to the operator terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.maybeRepairCodexSessionRoutes.mockResolvedValue({
    changes: [],
    warnings: [],
  });
});

it("applies the exact ephemeral auth map after earlier session migration owners", async () => {
  const authProfileIdMap = new Map([["openai-codex:default", "openai:chatgpt-default"]]);
  const retiredModelRefConfig = { agents: { defaults: { model: "openai/retired-model" } } };
  const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-session-owner" };
  const ctx = createDoctorHealthFlowContext({
    env,
    prompter: createDoctorPrompterFixture(true),
    configResult: {
      openAICodexAuthProfileIdMap: authProfileIdMap,
      retiredModelRefConfig,
      blockedCodexModelIdentities: ["codex\0gpt-5.6-sol"],
    },
  });

  await runCodexSessionRouteHealth(ctx);

  expect(mocks.maybeRepairCodexSessionRoutes).toHaveBeenCalledWith({
    cfg: ctx.cfg,
    env,
    shouldRepair: true,
    authProfileIdMap,
    retiredModelRefConfig,
    blockedModelIdentities: new Set(["codex\0gpt-5.6-sol"]),
  });
});

it("keeps preview mode read-only without inventing an auth migration map", async () => {
  const ctx = createDoctorHealthFlowContext({ env: {} });

  await runCodexSessionRouteHealth(ctx);

  expect(mocks.maybeRepairCodexSessionRoutes).toHaveBeenCalledWith({
    cfg: ctx.cfg,
    env: {},
    shouldRepair: false,
  });
});

it.each([
  { requiresFullDoctor: true, warnings: [] },
  { warnings: ["A model route still needs repair."] },
])("returns constrained or incomplete session discovery to full Doctor", async (outcome) => {
  mocks.maybeRepairCodexSessionRoutes.mockResolvedValue({ changes: [], ...outcome });
  const ctx = createDoctorHealthFlowContext({ retirementOnly: true });

  await runCodexSessionRouteHealth(ctx);

  expect(ctx.retirementOnly).toBe(false);
});
