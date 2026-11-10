import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

// A re-bind starts only once the claw's registration at Discovery is settled.
afterEach(() => {
  vi.restoreAllMocks();
});

const config = {
  enabled: true,
  discoveryUrl: "https://discovery.example.test",
  relayUrl: "https://relay.example.test/",
};

describe("re-bind before the registration receipt is settled", () => {
  it("is refused while Discovery cannot say whether it registered this claw", async () => {
    const claw = await linkedClaw();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const { service } = serviceFor(claw.authority, config);
    expect(await service.rebind("prepare", "local_operator")).toMatchObject({
      ok: false,
      code: "registration_unsettled",
    });
    // Nothing was staged.
    expect(fs.readdirSync(path.join(claw.stateDir, "openclaw-id"))).toEqual(["gateway.key"]);
  });

  it("is refused when the Gateway key Discovery would know is gone", async () => {
    const claw = await linkedClaw();
    const fetch = vi.spyOn(globalThis, "fetch");
    fs.rmSync(path.join(claw.stateDir, "openclaw-id", "gateway.key"));
    const { service } = serviceFor(claw.authority, config);
    expect(await service.rebind("commit", "local_operator", {})).toMatchObject({
      ok: false,
      code: "registration_unsettled",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is refused over the tunnel before anything else", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority, config);
    for (const action of ["prepare", "commit", "cancel"] as const) {
      expect(await service.rebind(action, "tunnel")).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
    }
  });
});
