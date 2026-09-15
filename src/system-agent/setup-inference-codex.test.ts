import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { stageCodexCandidate } from "./setup-inference-codex.js";

vi.mock("../plugins/enable.js", () => ({
  enablePluginWithCapabilityConsent: async (config: OpenClawConfig) => ({ enabled: true, config }),
}));

afterEach(() => vi.restoreAllMocks());

describe("Codex setup session ownership", () => {
  it.each([undefined, "agent", "user"] as const)(
    "does not replace homeScope=%s with native history sharing",
    async (homeScope) => {
      await withOpenClawTestState({ prefix: "codex-setup-scope-" }, async (state) => {
        const cfg: OpenClawConfig = {
          plugins: { entries: { codex: { enabled: true, config: { appServer: { homeScope } } } } },
        };
        await state.writeConfig(cfg);
        const result = await stageCodexCandidate(
          {
            cfg,
            snapshot: await readConfigFileSnapshot(),
            routeAgentId: "main",
            workspace: state.workspaceDir,
            agentDir: state.agentDir(),
            credentialsSaved: false,
            beforePersistentEffect: async () => {},
            deps: {
              readCodexCliActiveApiKey: () => null,
              ensureCodexRuntimePlugin: async ({ cfg: candidateConfig }) => ({
                ok: true,
                cfg: candidateConfig,
                required: false,
              }),
            },
            params: { kind: "codex-cli", surface: "cli", runtime: createNonExitingRuntime() },
          },
          "openai/default",
        );
        expect(result).toMatchObject({ agentRuntimeId: "codex" });
        if ("error" in result) {
          throw new Error(result.error);
        }
        expect(result.config.plugins?.entries?.codex?.config?.appServer).toEqual({
          transport: "stdio",
          homeScope,
        });
        expect(result.authProfileId).toBeUndefined();
      });
    },
  );
});
