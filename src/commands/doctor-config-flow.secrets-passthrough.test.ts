import { describe, expect, it, vi } from "vitest";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

describe("doctor config flow secrets passthrough", () => {
  it("preserves custom user-defined keys in the secrets section during --fix", async () => {
    const result = await runDoctorConfigWithInput({
      repair: true,
      config: {
        secrets: {
          brave_news_api_key: "sk-test-brave",
          my_custom_token: "tok-123",
          providers: {
            myVault: { source: "exec", command: "vault read" },
          },
        },
      },
      run: loadAndMaybeMigrateDoctorConfig,
    });

    const cfg = result.cfg as {
      secrets?: Record<string, unknown>;
    };
    expect(cfg.secrets).toBeDefined();
    expect(cfg.secrets!.brave_news_api_key).toBe("sk-test-brave");
    expect(cfg.secrets!.my_custom_token).toBe("tok-123");
    expect(cfg.secrets!.providers).toEqual({
      myVault: { source: "exec", command: "vault read" },
    });
  });
});
