import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOutboundActionRoute } from "./message-tool-outbound-route.js";
import {
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
  type TurnSendReservation,
  type TurnSendReserveResult,
} from "./turn-send-ledger.js";

// Stand-in for a provider target normalizer: case-fold and strip a leading "tg:" prefix,
// mirroring a real telegram plugin normalizer. This is the exact canonicalizer the ledger
// key (buildTurnSendTargetKey) and the delivery path apply, so the route resolver must fold
// equivalent spellings ("TG:12345" / "12345") through it before the distinct-target bail.
// Mocking the module here binds both the route's canonicalizeRouteTarget and the ledger key
// to this one normalizer, matching production where both read the same provider contract.
vi.mock("../../infra/outbound/target-normalization.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/target-normalization.js")>()),
  normalizeTargetForProvider: (_channel: string, raw?: string): string | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    const lowered = trimmed.toLowerCase();
    return lowered.startsWith("tg:") ? lowered.slice("tg:".length) : lowered;
  },
}));

// The route only reads getChannelPlugin to hand the action's alias spec to
// resolveActionDeliveryTargetAlias, which is mocked below; no real plugin runtime is needed.
vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: () => undefined,
}));

const deliveryAlias = vi.hoisted(() => ({
  resolve: vi.fn<() => string | undefined>(() => undefined),
}));

// Drive the plugin-declared delivery-alias candidate directly so the resolver's merge of
// target/to/channelId + delivery alias is exercised without wiring a real alias spec.
vi.mock("../../infra/outbound/message-action-spec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/message-action-spec.js")>()),
  resolveActionDeliveryTargetAlias: () => deliveryAlias.resolve(),
}));

afterEach(() => {
  deliveryAlias.resolve.mockReset().mockReturnValue(undefined);
  resetTurnSendLedgerForTest();
});

// The canonical key the telegram-like normalizer resolves target 12345 to, through the
// default account. Equivalent spellings must all produce this exact byte string.
const KEY_12345 = "telegram\u0000default\u000012345";

type RouteParams = Parameters<typeof resolveOutboundActionRoute>[0];

function route(
  overrides: Partial<RouteParams> & { args: Record<string, unknown> },
): string | undefined {
  return resolveOutboundActionRoute({
    action: "send",
    channel: "telegram",
    resolveAccountId: () => undefined,
    ...overrides,
  });
}

describe("resolveOutboundActionRoute canonicalization", () => {
  it("collapses equivalent target/to spellings of one peer into a single budget route", () => {
    // "TG:12345" and "12345" name the same telegram peer. Pre-fix these compared as two
    // distinct raw strings, so the Set held two entries, the multi-target guard bailed to
    // undefined, and the send escaped the per-turn budget entirely. Folding each candidate
    // through the provider normalizer collapses them to one route that the budget keys on.
    expect(route({ args: { target: "TG:12345", to: "12345" } })).toBe(KEY_12345);
    expect(route({ args: { target: "12345", to: "tg:12345" } })).toBe(KEY_12345);
  });

  it("collapses a case-only target/channelId divergence", () => {
    expect(route({ args: { target: "TG:12345", channelId: "tg:12345" } })).toBe(KEY_12345);
  });

  it("keeps genuinely distinct target/to destinations ambiguous (fail open)", () => {
    // Two real peers must still bail to undefined so the budget stays inert rather than
    // suppressing a legitimate second destination. This is the preserved fail-open path.
    expect(route({ args: { target: "12345", to: "67890" } })).toBeUndefined();
    expect(route({ args: { target: "TG:12345", to: "67890" } })).toBeUndefined();
  });

  it("collapses a plugin delivery alias equivalent to the explicit target", () => {
    // The delivery alias is the same peer under a prefixed spelling.
    deliveryAlias.resolve.mockReturnValue("TG:12345");
    expect(route({ args: { target: "12345" } })).toBe(KEY_12345);
  });

  it("keeps a plugin delivery alias naming a different destination ambiguous", () => {
    deliveryAlias.resolve.mockReturnValue("67890");
    expect(route({ args: { target: "12345" } })).toBeUndefined();
  });

  it("routes a no-target send to the canonical current source target", () => {
    expect(route({ args: {}, currentMessagingTarget: "TG:12345" })).toBe(KEY_12345);
  });

  it("shares one route when the explicit target equals the current source under a different spelling", () => {
    // An explicit target that is an alias of the current source must resolve to the same
    // route as a bare current-source send, so a mix of the two in one turn shares a slot.
    const current = route({ args: {}, currentMessagingTarget: "12345" });
    const aliased = route({ args: { target: "TG:12345" }, currentMessagingTarget: "12345" });
    expect(current).toBe(KEY_12345);
    expect(aliased).toBe(current);
  });

  it("keys on the resolved delivery account, resolved from the target as spelled", () => {
    // Binding lookups match exact peer ids, so the account resolver sees the caller's
    // spelling while the key still carries the canonical target.
    const resolveAccountId = vi.fn(() => "primary");
    expect(route({ args: { target: "TG:12345", to: "12345" }, resolveAccountId })).toBe(
      "telegram\u0000primary\u000012345",
    );
    expect(resolveAccountId).toHaveBeenCalledWith({ channel: "telegram", target: "TG:12345" });
  });

  it("returns undefined when neither a target nor a current source resolves", () => {
    expect(route({ args: {} })).toBeUndefined();
  });
});

function expectReserved(result: TurnSendReserveResult): TurnSendReservation {
  if (result.status !== "reserved") {
    throw new Error(`expected a reserved reservation, got "${result.status}"`);
  }
  return result.reservation;
}

describe("resolveOutboundActionRoute cap/nudge consequence", () => {
  // The two production owners the message tool chains: the route builds the ledger key, the
  // ledger counts committed sends against it. Feeding real route output into the real ledger
  // proves equivalent aliases share one budget slot (nudge/cap) while distinct peers do not.
  const scope = { sessionKey: "agent:test:telegram:budget", runId: "run-1" };

  it("folds equivalent-alias sends into one slot so the committed count reaches the nudge", () => {
    const first = route({ args: { target: "TG:12345" } });
    const second = route({ args: { to: "12345" } });
    expect(first).toBe(second);
    const key = { ...scope, targetKey: first! };
    commitTurnSend(expectReserved(reserveTurnSend(key, {})));
    commitTurnSend(expectReserved(reserveTurnSend(key, {})));
    // Two differently-spelled sends land in one slot, so the count is 2 (nudge threshold),
    // not 1-and-1 across two silently-separate routes.
    expect(peekTurnSendCount(key)).toBe(2);
  });

  it("caps a second equivalent-alias send while a genuinely distinct peer stays free", () => {
    const shared = route({ args: { target: "TG:12345" } });
    const sharedAlias = route({ args: { to: "12345" } });
    const distinct = route({ args: { target: "67890" } });
    expect(shared).toBe(sharedAlias);
    expect(distinct).not.toBe(shared);

    const sharedKey = { ...scope, targetKey: shared! };
    // First send to the shared peer commits the single-slot cap.
    commitTurnSend(
      expectReserved(reserveTurnSend(sharedKey, { maxPerTurn: 1, operationId: "op-1" })),
    );
    // A second send that names the same peer under a different spelling resolves to the same
    // key, so it is exhausted (cap-blocked) rather than slipping through a separate route.
    expect(reserveTurnSend(sharedKey, { maxPerTurn: 1, operationId: "op-2" }).status).toBe(
      "exhausted",
    );
    // A genuinely distinct peer keeps its own budget and is admitted.
    expect(
      reserveTurnSend({ ...scope, targetKey: distinct! }, { maxPerTurn: 1, operationId: "op-3" })
        .status,
    ).toBe("reserved");
  });
});
