import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { createOpenClawIdService } from "./service.js";

// Lets a test hold the Gateway key load, the last step before the Discovery request.
const signerLoad = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock("./gateway-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-key.js")>();
  return {
    ...actual,
    loadGatewaySigner: async (stateDir: string) => {
      await signerLoad.gate;
      return await actual.loadGatewaySigner(stateDir);
    },
  };
});

let config: GatewayOpenClawIdConfig = {
  enabled: true,
  loaderDomain: "crabd.test",
  discoveryUrl: "https://discovery.example.test",
};
const enabledConfig = config;

let stateDir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

// A service whose Discovery answers every request with `body` and `status`.
function serviceAnswering(body: unknown, status = 200) {
  fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return createOpenClawIdService({
    getConfig: () => config,
    getStateDir: () => stateDir,
    getGatewayServer: () => undefined,
    log: { info: vi.fn(), warn: vi.fn() },
  });
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-id-claw-name-"));
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  signerLoad.gate = undefined;
  config = enabledConfig;
  fetchSpy.mockRestore();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("OpenClaw ID claw name check", () => {
  it("asks Discovery for the code account's address, signed as the Gateway", async () => {
    const service = serviceAnswering({
      name: "studio",
      account_tag: "k7x2q",
      hostname: "studio-k7x2q.crabd.test",
      available: true,
    });
    const result = await service.checkClawName("local_operator", {
      enrollmentCode: "ABCDE-FGHJK",
      name: "studio",
    });
    expect(result).toEqual({
      name: "studio",
      accountTag: "k7x2q",
      hostname: "studio-k7x2q.crabd.test",
      available: true,
    });
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://discovery.example.test/v1/claw-names");
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual({
      code: "ABCDE-FGHJK",
      name: "studio",
    });
    expect(
      Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase()),
    ).toContain("openclaw-signature");
  });

  it("refuses relayed callers and missing input without calling Discovery", async () => {
    const service = serviceAnswering({});
    expect(
      await service.checkClawName("tunnel", { enrollmentCode: "ABCDE-FGHJK", name: "studio" }),
    ).toMatchObject({ ok: false, code: "not_local_operator" });
    expect(await service.checkClawName("local_operator", { name: "studio" })).toMatchObject({
      ok: false,
      code: "malformed",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an address that is not one label under the loader domain", async () => {
    const service = serviceAnswering({
      name: "studio",
      account_tag: "k7x2q",
      hostname: "studio-k7x2q.evil.test",
      available: true,
    });
    expect(
      await service.checkClawName("local_operator", {
        enrollmentCode: "ABCDE-FGHJK",
        name: "studio",
      }),
    ).toMatchObject({ ok: false, code: "wrong_domain" });
  });

  it("passes Discovery's error code through", async () => {
    const service = serviceAnswering(
      { error: { code: "code_invalid", message: "enrollment code unknown, used or expired" } },
      410,
    );
    expect(
      await service.checkClawName("local_operator", {
        enrollmentCode: "ABCDE-FGHJK",
        name: "studio",
      }),
    ).toMatchObject({ ok: false, code: "code_invalid" });
  });

  it("sends nothing when remote access is turned off while the request is prepared", async () => {
    const service = serviceAnswering({
      name: "studio",
      account_tag: "k7x2q",
      hostname: "studio-k7x2q.crabd.test",
      available: true,
    });
    let release!: () => void;
    signerLoad.gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = service.checkClawName("local_operator", {
      enrollmentCode: "ABCDE-FGHJK",
      name: "studio",
    });
    config = { enabled: false };
    await service.reconcileRuntimePolicy();
    release();

    expect(await pending).toMatchObject({ ok: false, code: "off" });
    // The link code never leaves the Gateway once the operator turned remote access off.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
