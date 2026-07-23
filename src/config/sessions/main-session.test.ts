import { describe, expect, it } from "vitest";
import {
  applyConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
} from "../runtime-overrides.js";
import type { OpenClawConfig } from "../types.js";
import { validateConfigObject } from "../validation.js";
import { resolveMainSessionKey, resolveSessionRoutingContract } from "./main-session.js";

describe("main session routing", () => {
  it("uses the default agent from keyed entries without the internal list projection", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "home" },
      agents: {
        entries: {
          worker: {},
          jarvis: { default: true },
        },
      },
    };

    expect(resolveMainSessionKey(cfg)).toBe("agent:jarvis:home");
    expect(resolveSessionRoutingContract(cfg)).toBe("per-sender|home|jarvis");
  });

  it("keeps keyed routing after a runtime override copies the agents object", () => {
    const validated = validateConfigObject({
      agents: {
        entries: {
          jarvis: { default: true },
          worker: {},
        },
      },
    });
    if (!validated.ok) {
      throw new Error("expected valid keyed agent config");
    }

    const override = setConfigOverride("agents.defaults.workspace", "/tmp/runtime-workspace");
    expect(override.ok).toBe(true);
    try {
      const runtimeConfig = applyConfigOverrides(validated.config);

      expect(runtimeConfig).not.toBe(validated.config);
      expect(runtimeConfig.agents?.defaults?.workspace).toBe("/tmp/runtime-workspace");
      expect(resolveMainSessionKey(runtimeConfig)).toBe("agent:jarvis:main");
      expect(resolveSessionRoutingContract(runtimeConfig)).toBe("per-sender|main|jarvis");
    } finally {
      resetConfigOverrides();
    }
  });
});
