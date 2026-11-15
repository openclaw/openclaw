import { beforeEach, expect, it, vi } from "vitest";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { resolveCronCreationDelivery } from "./delivery-context.js";

const { extractDeliveryInfoMock } = vi.hoisted(() => ({ extractDeliveryInfoMock: vi.fn() }));
vi.mock("../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));
const sessionKey = "agent:main:dashboard:conversation";
const stored = { channel: "discord", to: "channel:stored" };
function route(channel: string, to: string, rest: DeliveryContext = {}): DeliveryContext {
  return { channel, to, ...rest };
}
beforeEach(() => extractDeliveryInfoMock.mockReset());

it.each<{
  current?: DeliveryContext;
  saved?: DeliveryContext;
  threadId?: string;
  key?: string | null;
  expected?: DeliveryContext;
  reads: number;
}>([
  {
    current: route(" Matrix ", " !AbCd:Example.Org ", {
      accountId: " Bot-A ",
      threadId: " $Root:Example.Org ",
    }),
    saved: stored,
    expected: route("matrix", "!AbCd:Example.Org", {
      accountId: "bot-a",
      threadId: "$Root:Example.Org",
    }),
    reads: 0,
  },
  {
    saved: route("line", "Cabcdef", { accountId: "primary" }),
    expected: route("line", "Cabcdef", { accountId: "primary" }),
    reads: 1,
  },
  {
    saved: route("telegram", "-1001234567890", { threadId: "stale-topic" }),
    threadId: "99",
    expected: route("telegram", "-1001234567890", { threadId: "99" }),
    reads: 1,
  },
  {
    current: route("custom-plugin", "CaseSensitiveRecipient"),
    saved: stored,
    expected: route("custom-plugin", "CaseSensitiveRecipient"),
    reads: 0,
  },
  { current: route("matrix", "   "), key: null, reads: 0 },
  { reads: 1 },
  { saved: route("webchat", sessionKey), reads: 1 },
  ...[" WebChat ", "cron"].map((channel) => ({
    current: route(channel, sessionKey, {
      accountId: "internal-account",
      threadId: "internal-thread",
    }),
    saved: stored,
    reads: 0,
  })),
  { current: { channel: " WebChat " }, saved: stored, reads: 0 },
])(
  "resolves live/stored routes without leaking internal context %#",
  async ({ current, saved, threadId, key = sessionKey, expected, reads }) => {
    extractDeliveryInfoMock.mockReturnValueOnce({ deliveryContext: saved, threadId });
    expect(
      await resolveCronCreationDelivery({
        cfg: {},
        agentSessionKey: key ?? undefined,
        currentDeliveryContext: current,
      }),
    ).toEqual(expected ? { mode: "announce", ...expected } : null);
    expect(extractDeliveryInfoMock).toHaveBeenCalledTimes(reads);
  },
);
