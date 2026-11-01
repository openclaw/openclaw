import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveRootSigner,
  formatEd25519PublicKey,
  generateEd25519Signer,
  generateKitSecret,
  OWNER_CAPABILITIES,
  signStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import {
  memoryStore,
  nowSeconds,
  regenerationFor,
  TEST_K_SRV,
} from "./openclaw-id.test-support.js";
import { PUBLICATION_REFRESH_MS } from "./publication-retry.js";
import { createOpenClawIdService, type OpenClawIdService } from "./service.js";

// Replace the native tunnel and mailbox loop, not the service's publication owner.
vi.mock("./tunnel-runtime.js", () => ({
  startTunnelRuntime: async (params: { settings: unknown }) => ({
    settings: params.settings,
    supervisor: { status: () => ({ state: "running", endpointKey: TEST_K_SRV }) },
    pushMembership: vi.fn(),
    stop: async () => {},
  }),
}));
vi.mock("./mailbox-reader.js", () => ({ startMailboxReader: () => ({ stop() {} }) }));

let stateDir: string;
let service: OpenClawIdService;

beforeEach(() => {
  vi.useFakeTimers();
  stateDir = mkdtempSync(path.join(tmpdir(), "ocid-publication-refresh-"));
  // Fixed external Discovery answers; signing, authority and publication are real.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = url.endsWith("/v1/claw-names")
      ? {
          name: "studio",
          account_tag: "k7x2q",
          hostname: "studio-k7x2q.claws.test",
          available: true,
        }
      : url.endsWith("/v1/claws")
        ? { owner_account_id: "acct-owner" }
        : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const authority = createOpenClawIdAuthority(memoryStore());
  service = createOpenClawIdService({
    getConfig: () => ({
      enabled: true,
      loaderDomain: "claws.test",
      discoveryUrl: "https://discovery.test",
      relayUrl: "https://relay.test/",
    }),
    getStateDir: () => stateDir,
    getGatewayServer: () => undefined,
    log: { info: vi.fn(), warn: vi.fn() },
    createAuthority: async () => authority,
  });
});

afterEach(async () => {
  await service.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(stateDir, { recursive: true, force: true });
});

// Link through the running service with the statements its loopback browser signs.
async function commitLink() {
  await service.reconcileRuntimePolicy();
  const prep = await service.prepareLink("local_operator", {
    enrollmentCode: "ABCDE-FGHJK",
    name: "studio",
  });
  if ("ok" in prep) {
    throw new Error(prep.detail);
  }
  const root = await deriveRootSigner(generateKitSecret());
  const device = await generateEd25519Signer();
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [],
      label: "loopback",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      expires_at: null,
      root_epoch: 1,
    },
    root,
  );
  const owner_device = await signStatement(
    "MembershipChange",
    {
      claw_id: prep.claw_id,
      seq: 1,
      target: { op: "add_owner_device", cert },
      issued_at: nowSeconds(),
    },
    root,
  );
  const binding = await signStatement("ServerBinding", { ...prep, issued_at: nowSeconds() }, root);
  expect(
    await service.commitLink(
      "local_operator",
      {
        root_pub: formatEd25519PublicKey(root.publicKey),
        owner_device,
        binding,
      },
      "ABCDE-FGHJK",
    ),
  ).toMatchObject({ ok: true, publication: { state: "published" } });
}

// Check the caller-visible publication, not private scheduler state.
async function expectArmed() {
  const publication = (await service.linkStatus()).publication;
  expect(publication?.state).toBe("published");
  if (publication?.state !== "published") {
    throw new Error("not published");
  }
  expect(publication.refreshAt).toBeGreaterThanOrEqual(Date.now() + PUBLICATION_REFRESH_MS * 0.9);
  expect(publication.refreshAt).toBeLessThanOrEqual(Date.now() + PUBLICATION_REFRESH_MS);
}

describe("service publication refresh scheduling", () => {
  it("arms after a successful fresh commitLink", async () => {
    await commitLink();
    await expectArmed();
  });

  it("arms after successful owner-key regeneration", async () => {
    await commitLink();
    const prep = await service.prepareRegeneration("local_operator");
    if ("ok" in prep) {
      throw new Error(prep.detail);
    }
    const { input } = await regenerationFor(prep);
    expect(await service.regenerateOwnerKey("local_operator", input)).toMatchObject({
      ok: true,
      publication: { state: "published" },
    });
    await expectArmed();
  });

  it("arms at startup and again after direct publication", async () => {
    await commitLink();
    await service.stop();
    await service.reconcileRuntimePolicy();
    await expectArmed();
    await vi.advanceTimersByTimeAsync(PUBLICATION_REFRESH_MS / 2);
    expect(await service.publish()).toMatchObject({ state: "published" });
    await expectArmed();
  });
});
