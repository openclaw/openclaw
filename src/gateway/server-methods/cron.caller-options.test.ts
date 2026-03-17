import { describe, expect, it } from "vitest";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../method-scopes.js";
import { resolveCronCallerOptions } from "./cron.js";
import type { GatewayClient } from "./types.js";

function makeClient(scopes: string[]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "control-ui",
        version: "1.0.0",
        platform: "test",
        mode: "operator",
      },
      scopes,
    },
  } as GatewayClient;
}

describe("resolveCronCallerOptions", () => {
  it("sets ownerOverride=true for admin without sessionKey", () => {
    const opts = resolveCronCallerOptions(makeClient([ADMIN_SCOPE]));
    expect(opts.ownerOverride).toBe(true);
    expect(opts.callerSessionKey).toBeUndefined();
  });

  it("sets ownerOverride=false for admin WITH sessionKey", () => {
    const opts = resolveCronCallerOptions(makeClient([ADMIN_SCOPE]), "telegram:direct:111");
    expect(opts.ownerOverride).toBe(false);
    expect(opts.callerSessionKey).toBe("telegram:direct:111");
  });

  it("sets ownerOverride=false for non-admin without sessionKey", () => {
    const opts = resolveCronCallerOptions(makeClient([READ_SCOPE]));
    expect(opts.ownerOverride).toBe(false);
    expect(opts.callerSessionKey).toBeUndefined();
  });

  it("sets ownerOverride=false for non-admin with sessionKey", () => {
    const opts = resolveCronCallerOptions(
      makeClient([READ_SCOPE, WRITE_SCOPE]),
      "discord:channel:ops",
    );
    expect(opts.ownerOverride).toBe(false);
    expect(opts.callerSessionKey).toBe("discord:channel:ops");
  });

  it("handles null client gracefully", () => {
    const opts = resolveCronCallerOptions(null, "telegram:direct:111");
    expect(opts.ownerOverride).toBe(false);
    expect(opts.callerSessionKey).toBe("telegram:direct:111");
  });

  it("handles null client without sessionKey", () => {
    const opts = resolveCronCallerOptions(null);
    expect(opts.ownerOverride).toBe(false);
    expect(opts.callerSessionKey).toBeUndefined();
  });
});
