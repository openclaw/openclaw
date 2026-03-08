import { describe, expect, it } from "vitest";
import { validateTailscaleBindCompat } from "./config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

function makeConfig(gateway: NonNullable<OpenClawConfig["gateway"]>): OpenClawConfig {
  return { gateway } as OpenClawConfig;
}

describe("validateTailscaleBindCompat", () => {
  // ── Passes (returns null) ─────────────────────────────────────────────────

  it("passes when tailscale mode is off", () => {
    expect(validateTailscaleBindCompat(makeConfig({ tailscale: { mode: "off" } }))).toBeNull();
  });

  it("passes when tailscale mode is unset", () => {
    expect(validateTailscaleBindCompat(makeConfig({}))).toBeNull();
  });

  it("passes when tailscale=serve and bind=loopback", () => {
    expect(
      validateTailscaleBindCompat(makeConfig({ tailscale: { mode: "serve" }, bind: "loopback" })),
    ).toBeNull();
  });

  it("passes when tailscale=funnel and bind=loopback", () => {
    expect(
      validateTailscaleBindCompat(makeConfig({ tailscale: { mode: "funnel" }, bind: "loopback" })),
    ).toBeNull();
  });

  it("passes when tailscale=serve and bind=custom with loopback customBindHost (127.0.0.1)", () => {
    // bind=custom + customBindHost=127.0.0.1 is loopback at runtime — must be allowed at write-time too.
    expect(
      validateTailscaleBindCompat(
        makeConfig({
          tailscale: { mode: "serve" },
          bind: "custom",
          customBindHost: "127.0.0.1",
        }),
      ),
    ).toBeNull();
  });

  it("passes when tailscale=funnel and bind=custom with customBindHost=::1", () => {
    expect(
      validateTailscaleBindCompat(
        makeConfig({ tailscale: { mode: "funnel" }, bind: "custom", customBindHost: "::1" }),
      ),
    ).toBeNull();
  });

  // ── Rejects (returns error string) ───────────────────────────────────────

  it("rejects when tailscale=serve and bind=lan", () => {
    const err = validateTailscaleBindCompat(
      makeConfig({ tailscale: { mode: "serve" }, bind: "lan" }),
    );
    expect(err).toMatch(/gateway\.tailscale\.mode="serve"/);
    expect(err).toMatch(/gateway\.bind="loopback"/);
  });

  it("rejects when tailscale=funnel and bind=lan", () => {
    const err = validateTailscaleBindCompat(
      makeConfig({ tailscale: { mode: "funnel" }, bind: "lan" }),
    );
    expect(err).toMatch(/gateway\.tailscale\.mode="funnel"/);
  });

  it("rejects when tailscale=serve, bind=custom, and customBindHost is a non-loopback IP", () => {
    const err = validateTailscaleBindCompat(
      makeConfig({
        tailscale: { mode: "serve" },
        bind: "custom",
        customBindHost: "192.168.1.100",
      }),
    );
    expect(err).toMatch(/gateway\.bind="custom"/);
  });

  it("rejects when tailscale=serve, bind=custom, and customBindHost is empty", () => {
    const err = validateTailscaleBindCompat(
      makeConfig({ tailscale: { mode: "serve" }, bind: "custom", customBindHost: "" }),
    );
    expect(err).not.toBeNull();
  });
});
