import { describe, expect, it } from "vitest";
import { restoreCanonicalSecretRefs } from "./server-reload-utils.js";

describe("reload runtime projection", () => {
  it("restores canonical refs and source-only settings without restoring ignored properties", () => {
    const ref = { source: "env" as const, provider: "default", id: "FIXTURE_TOKEN" };
    const source = {
      future: true,
      gateway: { auth: { mode: "token" as const, token: ref } },
      channels: { discord: { token: ref, future: true } },
      logging: { level: "info" as const },
    };
    const runtime = {
      gateway: { auth: { mode: "token" as const, token: "resolved" } },
      channels: { discord: { token: undefined } },
    };
    expect(
      restoreCanonicalSecretRefs(runtime, source, [["future"], ["channels", "discord", "future"]]),
    ).toEqual({
      gateway: { auth: { mode: "token", token: ref } },
      channels: { discord: { token: ref } },
      logging: { level: "info" },
    });
    expect(runtime.gateway.auth.token).toBe("resolved");
    expect(source.channels.discord.future).toBe(true);
  });
});
