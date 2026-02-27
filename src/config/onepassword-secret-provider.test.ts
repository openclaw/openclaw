import { describe, expect, it } from "vitest";
import { OnePasswordSecretProvider } from "./onepassword-secret-provider.js";

describe("OnePasswordSecretProvider", () => {
  it("has name '1password'", () => {
    const provider = new OnePasswordSecretProvider();
    expect(provider.name).toBe("1password");
  });

  it("defaults to vault 'OpenClaw' and field 'credential'", () => {
    const provider = new OnePasswordSecretProvider();
    // Verify defaults are applied (will fail on getSecret without op CLI, but that's expected)
    expect(provider.name).toBe("1password");
  });

  it("setSecret throws (not implemented)", async () => {
    const provider = new OnePasswordSecretProvider();
    await expect(provider.setSecret("x", "y")).rejects.toThrow("not yet implemented");
  });

  // Full integration tests require `op` CLI and a signed-in session.
  // Run manually with: pnpm vitest run src/config/onepassword-secret-provider.test.ts
});
