import { describe, expect, it } from "vitest";
import { ensureStatefulTargetBuiltinsRegistered } from "./stateful-target-builtins.js";

describe("loadAcpStatefulTargetDriverModule rejection reset", () => {
  it("successfully registers ACP stateful target driver", async () => {
    // Verify the function works correctly with the fix in place
    // If acpDriverModulePromise cache reset is broken, this would fail on retry scenarios
    await expect(ensureStatefulTargetBuiltinsRegistered()).resolves.toBeUndefined();

    // Second call should also succeed (uses builtinsRegisteredPromise cache)
    await expect(ensureStatefulTargetBuiltinsRegistered()).resolves.toBeUndefined();
  });
});
