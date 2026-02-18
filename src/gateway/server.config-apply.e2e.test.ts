import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startGatewayServer,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

beforeAll(async () => {
  port = await getFreePort();
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

afterAll(async () => {
  await server.close();
});

const openClient = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws);
  return ws;
};

describe("gateway config.apply", () => {
  it("rejects invalid raw config", async () => {
    const ws = await openClient();
    try {
      const id = "req-1";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "config.apply",
          params: {
            raw: "{",
          },
        }),
      );
      const res = await onceMessage<{ ok: boolean; error?: { message?: string } }>(ws, (o) => {
        const msg = o as { type?: string; id?: string };
        return msg.type === "res" && msg.id === id;
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
    } finally {
      ws.close();
    }
  });

  it("requires raw to be a string", async () => {
    const ws = await openClient();
    try {
      const id = "req-2";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "config.apply",
          params: {
            raw: { gateway: { mode: "local" } },
          },
        }),
      );
      const res = await onceMessage<{ ok: boolean; error?: { message?: string } }>(ws, (o) => {
        const msg = o as { type?: string; id?: string };
        return msg.type === "res" && msg.id === id;
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain("raw");
    } finally {
      ws.close();
    }
  });
});

// ── Destructive guard tests ─────────────────────────────────────────────────
// These tests verify the guard that prevents config.apply from silently
// replacing a large config with a stub (issue #6395).

describe("gateway config.apply — destructive guard", () => {
  let ws2: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
  let server2: Awaited<ReturnType<typeof startServerWithClient>>["server"];

  // A "rich" config with 6 top-level sections (simulates a production config).
  const richConfig = JSON.stringify({
    gateway: { mode: "local" },
    agents: { list: [{ id: "primary", default: true, workspace: "/tmp/primary" }] },
    channels: {},
    auth: {},
    session: {},
    memory: {},
  });

  // A stub config with only 1 top-level section (drops 5 of 6 = 83% — catastrophic).
  const stubConfig = JSON.stringify({
    gateway: { mode: "local" },
  });

  // A "partial" config that drops 2 of 6 sections (33% — under the 50% threshold).
  const partialConfig = JSON.stringify({
    gateway: { mode: "local" },
    agents: { list: [{ id: "primary", default: true, workspace: "/tmp/primary" }] },
    channels: {},
    auth: {},
  });

  // A config that drops exactly 3 of 6 sections (50% — must be blocked, threshold is >50%).
  const exactlyHalfDroppedConfig = JSON.stringify({
    gateway: { mode: "local" },
    agents: { list: [{ id: "primary", default: true, workspace: "/tmp/primary" }] },
    channels: {},
  });

  beforeAll(async () => {
    const started = await startServerWithClient(undefined, { controlUiEnabled: true });
    server2 = started.server;
    ws2 = started.ws;
    await connectOk(ws2);
  });

  afterAll(async () => {
    ws2.close();
    await server2.close();
  });

  /**
   * Helper: write a config via config.set (no guard applies there), then return
   * the baseHash so subsequent config.apply calls use the correct base.
   */
  async function seedConfig(raw: string): Promise<string> {
    // First get current hash (may be empty on fresh server)
    const getRes = await rpcReq<{ hash?: string }>(ws2, "config.get", {});
    const currentHash = getRes.ok ? (getRes.payload?.hash ?? undefined) : undefined;

    const setRes = await rpcReq<{ hash?: string }>(ws2, "config.set", {
      raw,
      ...(currentHash ? { baseHash: currentHash } : {}),
    });
    expect(setRes.ok).toBe(true);

    // Re-fetch to get the hash after the write.
    const afterRes = await rpcReq<{ hash?: string }>(ws2, "config.get", {});
    expect(afterRes.ok).toBe(true);
    expect(typeof afterRes.payload?.hash).toBe("string");
    return afterRes.payload!.hash!;
  }

  it("happy path: full config applied — accepted", async () => {
    // Seed the server with the rich config first.
    const baseHash = await seedConfig(richConfig);

    // Apply the same rich config back — no sections dropped, must succeed.
    const res = await rpcReq<{ ok?: boolean }>(ws2, "config.apply", {
      raw: richConfig,
      baseHash,
    });
    expect(res.ok).toBe(true);
  });

  it("partial update: drops <50% of sections — accepted", async () => {
    const baseHash = await seedConfig(richConfig);

    // partialConfig drops 2 of 6 sections (33%) — under the threshold.
    const res = await rpcReq<{ ok?: boolean }>(ws2, "config.apply", {
      raw: partialConfig,
      baseHash,
    });
    expect(res.ok).toBe(true);
  });

  it("destructive guard: drops >50% of sections — rejected with informative error", async () => {
    const baseHash = await seedConfig(richConfig);

    // stubConfig drops 5 of 6 sections (83%) — must be blocked.
    const res = await rpcReq<{ ok?: boolean }>(ws2, "config.apply", {
      raw: stubConfig,
      baseHash,
    });
    expect(res.ok).toBe(false);
    const msg = res.error?.message ?? "";
    // Error must name the dropped section count and hint at the escape hatch.
    expect(msg).toMatch(/drop/i);
    expect(msg).toContain("allowDestructive");
    // Must list at least one of the dropped sections by name.
    expect(msg).toMatch(/agents|channels|auth|session|memory/i);
  });

  it("allowDestructive bypass: stub config with allowDestructive: true — accepted", async () => {
    const baseHash = await seedConfig(richConfig);

    // Same stub that was blocked above, but with allowDestructive: true.
    const res = await rpcReq<{ ok?: boolean }>(ws2, "config.apply", {
      raw: stubConfig,
      baseHash,
      allowDestructive: true,
    });
    expect(res.ok).toBe(true);
  });

  it("edge case: exactly 50% dropped — accepted (guard fires only at strictly >50%)", async () => {
    const baseHash = await seedConfig(richConfig);

    // exactlyHalfDroppedConfig drops 3 of 6 sections = 50.0%.
    // Guard condition: droppedKeys.length > existingKeys.length / 2
    // → 3 > 3 → false → NOT blocked.
    // Confirms the boundary: exactly 50% passes, >50% is blocked.
    const res = await rpcReq<{ ok?: boolean }>(ws2, "config.apply", {
      raw: exactlyHalfDroppedConfig,
      baseHash,
    });
    expect(res.ok).toBe(true);
  });
});
