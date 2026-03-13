import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { LookupFn } from "../infra/net/ssrf.js";
import { runLinkUnderstanding } from "./runner.js";

function createLookupFn(address: string, family = 4): LookupFn {
  return vi.fn(async () => [{ address, family }]) as unknown as LookupFn;
}

function minimalCtx() {
  return {
    Body: "",
    Provider: "test",
    SessionKey: "test-session",
  };
}

function cfgWithCliEntry(): OpenClawConfig {
  return {
    tools: {
      links: {
        enabled: true,
        models: [{ command: "echo", args: ["{{LinkUrl}}"] }],
      },
    },
  } as OpenClawConfig;
}

describe("CWE-918: SSRF bypass via DNS rebinding at usage stage", () => {
  it("should block URL whose hostname resolves to loopback at usage time", async () => {
    // Simulates DNS rebinding: hostname passes literal check in detect.ts
    // but resolves to 127.0.0.1 when the CLI tool actually fetches it.
    const lookupFn = createLookupFn("127.0.0.1");
    const cfg = cfgWithCliEntry();
    const result = await runLinkUnderstanding({
      cfg,
      ctx: { ...minimalCtx(), Body: "check https://rebind.attacker.com/steal" },
      lookupFn,
    });
    // URL is detected but CLI execution is blocked — no outputs produced
    expect(result.outputs).toEqual([]);
  });

  it("should block URL resolving to cloud metadata IP (169.254.169.254)", async () => {
    const lookupFn = createLookupFn("169.254.169.254");
    const cfg = cfgWithCliEntry();
    const result = await runLinkUnderstanding({
      cfg,
      ctx: { ...minimalCtx(), Body: "check https://rebind.attacker.com/metadata" },
      lookupFn,
    });
    expect(result.outputs).toEqual([]);
  });

  it("should block URL resolving to private network (10.x, 172.16.x, 192.168.x)", async () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1"]) {
      const lookupFn = createLookupFn(ip);
      const cfg = cfgWithCliEntry();
      const result = await runLinkUnderstanding({
        cfg,
        ctx: { ...minimalCtx(), Body: "check https://rebind.attacker.com/internal" },
        lookupFn,
      });
      expect(result.outputs).toEqual([]);
    }
  });

  it("should block URL resolving to IPv6 loopback (::1)", async () => {
    const lookupFn = createLookupFn("::1", 6);
    const cfg = cfgWithCliEntry();
    const result = await runLinkUnderstanding({
      cfg,
      ctx: { ...minimalCtx(), Body: "check https://rebind.attacker.com/v6" },
      lookupFn,
    });
    expect(result.outputs).toEqual([]);
  });

  it("should allow URL resolving to a public IP address", async () => {
    // This test verifies the SSRF check does NOT reject legitimate public IPs.
    // runExec will still fail (echo is not a real link tool), but the SSRF
    // guard itself should not throw.
    const lookupFn = createLookupFn("93.184.216.34");
    const cfg = cfgWithCliEntry();
    const result = await runLinkUnderstanding({
      cfg,
      ctx: { ...minimalCtx(), Body: "check https://example.com/page" },
      lookupFn,
    });
    // The SSRF guard passed; URL was detected even if CLI output is empty.
    expect(result.urls).toEqual(["https://example.com/page"]);
  });

  it("should detect URL but produce no output when hostname rebinds to private IP", async () => {
    // Use a non-blocked TLD so the URL passes detection-stage literal checks,
    // then rebinds to 127.0.0.1 at usage time.
    const lookupFn = createLookupFn("127.0.0.1");
    const cfg = cfgWithCliEntry();
    const result = await runLinkUnderstanding({
      cfg,
      ctx: { ...minimalCtx(), Body: "visit https://evil-rebind.example.com/secret" },
      lookupFn,
    });
    expect(result.urls).toEqual(["https://evil-rebind.example.com/secret"]);
    expect(result.outputs).toEqual([]);
  });
});
