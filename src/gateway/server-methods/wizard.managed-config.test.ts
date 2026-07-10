import { expect, it, vi } from "vitest";
import { OPENCLAW_CONFIG_MANAGED_ENV } from "../../config/config-ownership.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { wizardHandlers } from "./wizard.js";

it("rejects wizard.start before creating a setup session for managed config", async () => {
  await withEnvAsync(
    { [OPENCLAW_CONFIG_MANAGED_ENV]: "1", OPENCLAW_NIX_MODE: undefined },
    async () => {
      const respond = vi.fn();
      const findRunningWizard = vi.fn();
      const wizardRunner = vi.fn();
      const wizardSessions = new Map();

      await wizardHandlers["wizard.start"]({
        params: { mode: "local" },
        respond,
        context: {
          findRunningWizard,
          wizardRunner,
          wizardSessions,
          purgeWizardSession: vi.fn(),
        },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          details: { code: "OPENCLAW_CONFIG_MANAGED" },
        }),
      );
      expect(findRunningWizard).not.toHaveBeenCalled();
      expect(wizardRunner).not.toHaveBeenCalled();
      expect(wizardSessions.size).toBe(0);
    },
  );
});
