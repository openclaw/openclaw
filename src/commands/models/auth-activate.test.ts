import { afterEach, expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { modelsAuthActivateCommand } from "./auth-activate.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: async () => ({
    ok: true,
    modelRef: "sample/chat",
    latencyMs: 1,
    lines: ["Connection verified"],
  }),
}));
vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: async () => "refreshed",
}));
afterEach(() => vi.clearAllMocks());

it.each([
  { name: "applied account", appliedHash: "saved", profile: "replacement", activated: true },
  { name: "reload disabled", appliedHash: "old", profile: "replacement", activated: false },
  { name: "another account selected", appliedHash: "saved", profile: "other", activated: false },
  { name: "lost acknowledgement", appliedHash: null, profile: "replacement", activated: false },
])(
  "reports the saved sign-in accurately with $name",
  async ({ appliedHash, profile, activated }) => {
    const state = await createOpenClawTestState({ label: "activate-saved-sign-in" });
    try {
      await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      if (appliedHash === null) {
        mocks.callGateway.mockRejectedValue(new Error("connection closed"));
      } else {
        mocks.callGateway.mockResolvedValue({
          config: { agents: { entries: { main: { model: `sample/chat@${profile}` } } } },
          configRevisionHash: "saved",
          appliedConfigHash: appliedHash,
        });
      }
      await modelsAuthActivateCommand({ profileId: "replacement", agent: "main" }, runtime);
      const output = runtime.log.mock.calls.flat().join("\n");
      expect(output).toContain("Connection verified");
      if (activated) {
        expect(output).toContain("Saved sign-in activated");
      } else {
        expect(output).not.toContain("Saved sign-in activated");
        expect(output).toContain("verified and saved");
        expect(output).toContain("openclaw gateway restart");
      }
    } finally {
      await state.cleanup();
    }
  },
);
