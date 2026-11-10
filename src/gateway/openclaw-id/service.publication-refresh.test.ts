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
  type PublishSnapshotRequest,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { memoryStore, nowSeconds, TEST_K_SRV } from "./openclaw-id.test-support.js";
import { PUBLICATION_REFRESH_MS } from "./publication-retry.js";
import { createOpenClawIdService, type OpenClawIdService } from "./service.js";

// Replace the native tunnel and mailbox loop, not the service's publication owner.
// mock-isolation: the native tunnel runtime and Discovery mailbox loop stay out of these service tests.
vi.mock("./tunnel-runtime.js", () => ({
  startTunnelRuntime: async (params: { settings: unknown }) => ({
    settings: params.settings,
    supervisor: { status: () => ({ state: "running", endpointKey: TEST_K_SRV }) },
    pushMembership: vi.fn(),
    stop: async () => {},
  }),
}));
// mock-isolation: the native tunnel runtime and Discovery mailbox loop stay out of these service tests.
vi.mock("./mailbox-reader.js", () => ({ startMailboxReader: () => ({ stop() {} }) }));

let stateDir: string;
let service: OpenClawIdService;
let authority: ReturnType<typeof createOpenClawIdAuthority>;

beforeEach(() => {
  vi.useFakeTimers();
  stateDir = mkdtempSync(path.join(tmpdir(), "ocid-publication-refresh-"));
  // Fixed external Discovery answers; signing, authority and publication are real.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/registration")) {
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    }
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
  authority = createOpenClawIdAuthority(memoryStore());
  service = startService();
});

// A Gateway restart creates a new service over the same stored claw.
function startService(): OpenClawIdService {
  return createOpenClawIdService({
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
}

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
  const refreshAt = "refreshAt" in publication ? publication.refreshAt : undefined;
  expect(refreshAt).toBeGreaterThanOrEqual(Date.now() + PUBLICATION_REFRESH_MS * 0.9);
  expect(refreshAt).toBeLessThanOrEqual(Date.now() + PUBLICATION_REFRESH_MS);
}

describe("service publication refresh scheduling", () => {
  it("keeps a code given to publish for its retries after a transient failure", async () => {
    await commitLink();
    await authority.recordDiscovery({
      owner_account_id: null,
      published_binding_seq: 0,
      published_snapshot_seq: 0,
    });
    const answer = vi.mocked(globalThis.fetch).getMockImplementation()!;
    const codes: unknown[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/claws") && init?.method === "POST") {
        codes.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)).code);
        if (codes.length === 1) {
          return Response.json({ error: { code: "unavailable", message: "x" } }, { status: 503 });
        }
      }
      return await answer(input, init);
    });
    expect(await service.publish("FRESH-CODE")).toMatchObject({ state: "failed", retryable: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(async () =>
      expect((await service.linkStatus()).publication?.state).toBe("published"),
    );
    expect(codes).toEqual(["FRESH-CODE", "FRESH-CODE"]);
  });

  it("arms after a successful fresh commitLink", async () => {
    await commitLink();
    await expectArmed();
  });

  it.each(["matching", "wrong root", "wrong binding", "temporary outage"])(
    "reconciles missing registration at startup only for the exact committed identity (%s)",
    async (scenario) => {
      await commitLink();
      await service.stop();
      service = startService();
      const committed = authority.current()!;
      await authority.recordDiscovery({
        owner_account_id: null,
        published_binding_seq: 0,
        published_snapshot_seq: 0,
      });
      const descriptor = {
        v: 1,
        claw_id: committed.claw_id,
        transport: "iroh",
        relay_url: "https://relay.test/",
        root_pub:
          scenario === "wrong root"
            ? "ed25519:" + "00".repeat(32)
            : committed.authority!.anchor.root_pub,
        published_at: nowSeconds(),
        binding:
          scenario === "wrong binding"
            ? {
                ...committed.binding!,
                body: { ...committed.binding!.body, hostname: "another.claws.test" },
              }
            : committed.binding,
      };
      const writes: string[] = [];
      let lookups = 0;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/registration")) {
          lookups += 1;
          expect(new Headers(init?.headers).get("openclaw-signature")).toBeTruthy();
          if (scenario === "temporary outage" && lookups === 1) {
            return Response.json(
              { error: { code: "unavailable", message: "HTTP 503" } },
              { status: 503 },
            );
          }
          return Response.json({
            claw_id: committed.claw_id,
            owner_account_id: "acct-owner",
            descriptor,
          });
        }
        // Registration metadata must be durable before any remote publication is attempted.
        expect(authority.current()?.discovery.owner_account_id).toBe("acct-owner");
        writes.push(url);
        return new Response(null, { status: 204 });
      });
      await service.reconcileRuntimePolicy();
      // Startup publication runs beside the lifecycle; wait for its public outcome.
      await vi.waitFor(async () => {
        if (scenario === "matching") {
          await expectArmed();
        } else {
          expect((await service.linkStatus()).publication).toMatchObject({ state: "failed" });
        }
      });
      if (scenario === "temporary outage") {
        expect(authority.current()?.discovery.owner_account_id).toBeNull();
        expect((await service.linkStatus()).publication).toMatchObject({
          state: "failed",
          code: "unavailable",
        });
        await vi.advanceTimersByTimeAsync(2_000);
        // The timer starts async signing/file I/O; wait for the public completion, not timer delivery.
        await vi.waitFor(async () => {
          expect(lookups).toBe(2);
          await expectArmed();
        });
      }
      if (scenario === "matching" || scenario === "temporary outage") {
        expect(authority.current()?.discovery.owner_account_id).toBe("acct-owner");
        expect(writes.some((url) => url.endsWith("/snapshot"))).toBe(true);
        await expectArmed();
      } else {
        expect(authority.current()?.discovery.owner_account_id).toBeNull();
        expect(writes).toEqual([]);
        expect((await service.linkStatus()).publication).toMatchObject({
          state: "failed",
          code: "registration_mismatch",
        });
      }
    },
  );

  it("arms at startup and again after direct publication", async () => {
    await commitLink();
    await service.stop();
    service = startService();
    await service.reconcileRuntimePolicy();
    await vi.waitFor(expectArmed);
    await vi.advanceTimersByTimeAsync(PUBLICATION_REFRESH_MS / 2);
    expect(await service.publish()).toMatchObject({ state: "published" });
    await expectArmed();
  });

  it("keeps refreshing after a same-second restart publication is refused as stale", async () => {
    vi.setSystemTime(1_700_000_000_000);
    const snapshots: PublishSnapshotRequest["snapshot"][] = [];
    const discovery = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.endsWith("/snapshot")) {
        return discovery(input, init);
      }
      const { snapshot }: PublishSnapshotRequest = await request.json();
      const previous = snapshots.at(-1);
      // Discovery accepts a same-seq refresh only with a newer issued_at.
      if (
        previous &&
        snapshot.body.seq === previous.body.seq &&
        snapshot.body.issued_at <= previous.body.issued_at
      ) {
        return Response.json(
          { error: { code: "stale_snapshot", message: "issued_at must be newer" } },
          { status: 409 },
        );
      }
      snapshots.push(snapshot);
      return new Response(null, { status: 204 });
    });
    await commitLink();
    const issuedAt = snapshots[0]!.body.issued_at;
    await service.stop();
    service = startService();
    await service.reconcileRuntimePolicy();
    await vi.waitFor(async () => {
      expect((await service.linkStatus()).publication).toMatchObject({
        state: "failed",
        code: "stale_snapshot",
        retryAt: undefined,
      });
    });
    expect(snapshots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PUBLICATION_REFRESH_MS);
    await vi.waitFor(async () => {
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]!.body.issued_at).toBeGreaterThan(issuedAt);
      await expectArmed();
    });
  });
});
