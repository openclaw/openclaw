import { describe, expect, it, vi } from "vitest";
import {
  ManagedConfigMutationError,
  OPENCLAW_CONFIG_MANAGED_ENV,
} from "../../config/config-ownership.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { rejectExternallyManagedConfigMutation } from "./config-mutation-guard.js";

describe("rejectExternallyManagedConfigMutation", () => {
  it("returns the stable managed-config gateway error", async () => {
    await withEnvAsync(
      { [OPENCLAW_CONFIG_MANAGED_ENV]: "1", OPENCLAW_NIX_MODE: undefined },
      async () => {
        const respond = vi.fn();
        const error = new ManagedConfigMutationError();

        expect(rejectExternallyManagedConfigMutation(respond)).toBe(true);
        expect(respond).toHaveBeenCalledWith(false, undefined, {
          code: "INVALID_REQUEST",
          message: error.message,
          retryable: false,
          details: { code: error.code },
        });
      },
    );
  });

  it("leaves Nix mutations on the existing Nix-specific error path", async () => {
    await withEnvAsync({ [OPENCLAW_CONFIG_MANAGED_ENV]: "1", OPENCLAW_NIX_MODE: "1" }, async () => {
      const respond = vi.fn();

      expect(rejectExternallyManagedConfigMutation(respond)).toBe(false);
      expect(respond).not.toHaveBeenCalled();
    });
  });
});
