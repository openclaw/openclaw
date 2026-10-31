import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.factory.js";
import { withTempHomeConfig } from "./test-helpers.js";
import { validateConfigObject } from "./validation.js";

describe("independent policy defaults", () => {
  it("does not expand absent policy controls when reading a configuration", async () => {
    const source = { agents: { entries: { main: {} } } };
    await withTempHomeConfig(source, async ({ configPath }) => {
      const io = createConfigIO({
        env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
        observe: false,
        pluginValidation: "core-only",
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig).toEqual(source);
      expect(snapshot.runtimeConfig.security).toBeUndefined();
      expect(snapshot.runtimeConfig.tools).toBeUndefined();
      expect(snapshot.runtimeConfig.agents?.defaults?.sandbox).toBeUndefined();
      expect(snapshot.runtimeConfig.messages?.queue?.allowCollaborativeSteering).toBe(true);
      expect(snapshot.runtimeConfig.session?.dmScope).toBeUndefined();
    });
  });

  it.each(["personal", "corporate"])("rejects the removed %s preset", (preset) => {
    const result = validateConfigObject({ security: { preset } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "security", message: expect.stringContaining("preset") }),
      );
    }
  });
});
