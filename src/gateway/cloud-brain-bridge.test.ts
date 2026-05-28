import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBenchCloudAgentId, resolveBenchCloudBridgeConfig } from "./cloud-brain-bridge.js";

describe("Bench cloud bridge agent aliases", () => {
  it("maps Cory's local Aurelius profile id to the canonical platform agent id", () => {
    const config = resolveBenchCloudBridgeConfig({} as OpenClawConfig);

    expect(resolveBenchCloudAgentId({ config, agentId: "kestrel-aurelius" })).toBe("aurelius");
    expect(resolveBenchCloudAgentId({ config, agentId: "Kestrel-Aurelius" })).toBe("aurelius");
  });

  it("keeps canonical ids stable and supports configured aliases", () => {
    const config = resolveBenchCloudBridgeConfig({
      gateway: {
        benchCloud: {
          agentIdAliases: {
            "local-sage": "sage",
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(resolveBenchCloudAgentId({ config, agentId: "aurelius" })).toBe("aurelius");
    expect(resolveBenchCloudAgentId({ config, agentId: "local-sage" })).toBe("sage");
  });
});
