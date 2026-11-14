import { describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_SIGNATURE_HEADER,
  generateEd25519Signer,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createDiscoveryClient } from "./discovery-client.js";
import { sendOwnerNotices } from "./owner-notices.js";

const CLAW_ID = "c1".repeat(16);

describe("OpenClaw ID owner notices", () => {
  it("mails one K_gw-signed notice to the owner devices per notify_owners event", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ message_id: "m1", expires_at: 1 }), { status: 201 });
    });
    const client = createDiscoveryClient({
      baseUrl: "https://discovery.example.test",
      signer: await generateEd25519Signer(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const log = { info: vi.fn(), warn: vi.fn() };
    await sendOwnerNotices({
      events: [
        { type: "publish_snapshot" },
        { type: "notify_owners", event: "redemption_pending", ref: "ab".repeat(16) },
        { type: "notify_owners", event: "kit_used", ref: "fp:xyz" },
      ],
      target: async () => ({ clawId: CLAW_ID, client }),
      log,
    });
    expect(requests.map((request) => request.url)).toEqual([
      `https://discovery.example.test/v1/claws/${CLAW_ID}/mailbox`,
      `https://discovery.example.test/v1/claws/${CLAW_ID}/mailbox`,
    ]);
    const [first] = requests;
    const headers = first!.init.headers as Record<string, string>;
    expect(headers[DISCOVERY_SIGNATURE_HEADER]).toBeTruthy();
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
    expect(JSON.parse(new TextDecoder().decode(first!.init.body as Uint8Array))).toEqual({
      to: "owners",
      payload: { kind: "notice", event: "redemption_pending", ref: "ab".repeat(16) },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs and carries on before registration or when Discovery fails", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const events = [{ type: "notify_owners", event: "redemption_resolved", ref: "r" }] as const;
    await sendOwnerNotices({ events, target: async () => undefined, log });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not registered"));
    const failing = {
      sendOwnerNotice: vi.fn(async () => {
        throw new Error("down");
      }),
    };
    await sendOwnerNotices({
      events,
      target: async () => ({ clawId: CLAW_ID, client: failing }),
      log,
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("down"));
  });

  it("does nothing when there is no notice to send", async () => {
    const target = vi.fn(async () => undefined);
    await sendOwnerNotices({
      events: [{ type: "publish_snapshot" }],
      target,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(target).not.toHaveBeenCalled();
  });
});
