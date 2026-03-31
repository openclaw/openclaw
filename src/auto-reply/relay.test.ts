import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true })),
  isRoutableChannel: vi.fn((ch: unknown) => typeof ch === "string" && ch !== "webchat"),
}));

vi.mock("./reply/route-reply.js", () => ({
  routeReply: mocks.routeReply,
  isRoutableChannel: mocks.isRoutableChannel,
}));

import type { OpenClawConfig } from "../config/config.js";
import { wrapDeliverWithRelay } from "./relay.js";

function cfg(targets?: Array<{ channel: string; to: string; accountId?: string }>): OpenClawConfig {
  return targets
    ? ({ session: { relay: { targets } } } as unknown as OpenClawConfig)
    : ({} as unknown as OpenClawConfig);
}

const payload = { text: "hello" };
const finalInfo = { kind: "final" as const };
const blockInfo = { kind: "block" as const };

describe("wrapDeliverWithRelay", () => {
  it("returns original deliver when no relay targets configured", async () => {
    const deliver = vi.fn(async () => {});
    const wrapped = wrapDeliverWithRelay(deliver, { cfg: cfg() });
    expect(wrapped).toBe(deliver);
  });

  it("calls primary deliver before relaying", async () => {
    const order: string[] = [];
    const deliver = vi.fn(async () => {
      order.push("primary");
    });
    mocks.routeReply.mockImplementationOnce(async () => {
      order.push("relay");
      return { ok: true };
    });

    const wrapped = wrapDeliverWithRelay(deliver, {
      cfg: cfg([{ channel: "telegram", to: "123" }]),
    });
    await wrapped(payload, finalInfo);

    expect(order[0]).toBe("primary");
    expect(order[1]).toBe("relay");
  });

  it("skips relay targets that match the originating channel", async () => {
    const deliver = vi.fn(async () => {});
    mocks.routeReply.mockClear();

    const wrapped = wrapDeliverWithRelay(deliver, {
      originatingChannel: "telegram",
      cfg: cfg([{ channel: "telegram", to: "123" }]),
    });
    await wrapped(payload, finalInfo);

    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("relays to targets on a different channel", async () => {
    const deliver = vi.fn(async () => {});
    mocks.routeReply.mockClear();

    const wrapped = wrapDeliverWithRelay(deliver, {
      originatingChannel: "webchat",
      cfg: cfg([{ channel: "telegram", to: "456" }]),
    });
    await wrapped(payload, finalInfo);

    // routeReply is called fire-and-forget; wait a tick for it to execute
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", to: "456" }),
    );
  });

  it("does not relay non-final kinds (block, tool)", async () => {
    const deliver = vi.fn(async () => {});
    mocks.routeReply.mockClear();

    const wrapped = wrapDeliverWithRelay(deliver, {
      cfg: cfg([{ channel: "telegram", to: "789" }]),
    });
    await wrapped(payload, blockInfo);

    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.routeReply).not.toHaveBeenCalled();
  });

  it("passes sessionKey and accountId through to routeReply", async () => {
    const deliver = vi.fn(async () => {});
    mocks.routeReply.mockClear();

    const wrapped = wrapDeliverWithRelay(deliver, {
      sessionKey: "agent:abc:main",
      cfg: cfg([{ channel: "discord", to: "chan1", accountId: "acct42" }]),
    });
    await wrapped(payload, finalInfo);

    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "chan1",
        accountId: "acct42",
        sessionKey: "agent:abc:main",
        mirror: true,
      }),
    );
  });

  it("does not throw when routeReply rejects", async () => {
    const deliver = vi.fn(async () => {});
    mocks.routeReply.mockRejectedValueOnce(new Error("network error"));

    const wrapped = wrapDeliverWithRelay(deliver, {
      cfg: cfg([{ channel: "telegram", to: "999" }]),
    });

    await expect(wrapped(payload, finalInfo)).resolves.not.toThrow();
  });
});
