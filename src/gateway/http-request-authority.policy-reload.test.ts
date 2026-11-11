import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishCanonicalUserChannelPolicy } from "../state/user-channel-identity-operations.js";
import { useProfileState } from "../state/user-profiles-fixture.test-support.js";
import { captureHttpRequestAuthority } from "./http-request-authority.js";

describe("HTTP authority during channel policy publication", () => {
  useProfileState();

  it("preserves admitted requests across a no-op and revokes them on a policy change", async () => {
    let config: OpenClawConfig = {};
    const auth = { mode: "token", token: "test-token", allowTailscale: false } as const;
    await publishCanonicalUserChannelPolicy(config.gateway, undefined);

    const socket = new Socket();
    try {
      const isCurrent = captureHttpRequestAuthority({
        req: new IncomingMessage(socket),
        cfg: config,
        auth,
        getRuntimeConfig: () => config,
      });
      expect(isCurrent()).toBe(true);

      config = { agents: { defaults: { model: "test/model" } } };
      await publishCanonicalUserChannelPolicy(config.gateway, undefined);
      expect(isCurrent()).toBe(true);

      config = { ...config, gateway: { auth: { identityScopes: { "test-identity": [] } } } };
      await publishCanonicalUserChannelPolicy(config.gateway, undefined);
      expect(isCurrent()).toBe(false);
    } finally {
      socket.destroy();
    }
  });
});
