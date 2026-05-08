import { describe, expect, it, vi } from "vitest";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

/**
 * RED-LIGHT TDD spec for catalog finding #21:
 *   "totalTokens always null (totalTokensFresh: false) for ACP sessions".
 *
 * Symptom on main today:
 *   - Wire probe shows ACP sessionUpdates carry numeric `used` / `size` fields
 *     on `usage_update` events.
 *   - `acp-projector.ts` lines 462-474 extract those numbers ONLY for
 *     repeat-suppression hashing — they are not surfaced or persisted.
 *   - The acpx session record's `cumulative_token_usage` stays `{}`, and the
 *     listing's `resolveSessionTotalTokens(...)` falls back to `null`.
 *
 * Recommended fix shape (this spec assumes it):
 *   - `createAcpReplyProjector` accepts a new optional callback,
 *     `onTokenUsage?: (usage: { used: number; size: number; total: number })
 *      => void | Promise<void>`.
 *   - On every `status` event with `tag: "usage_update"` that carries numeric
 *     `used` / `size`, the projector calls `onTokenUsage` with the structured
 *     usage. `total` is the cumulative tokens used (= `used`); `size` is the
 *     advertised context window. Repeat-suppression for display still applies,
 *     but the structured callback fires regardless of dedupe state because
 *     persistence wants the latest known usage on every turn end.
 *   - The fix surface around this seam (NOT covered here, owner of the next
 *     test): `dispatch-acp.ts` will pass `onTokenUsage` so the dispatcher can
 *     persist the numbers into the acpx session record's
 *     `cumulative_token_usage` field, and `resolveSessionTotalTokens` falls
 *     back to that field when entry-level `totalTokens` is null.
 *
 * Each `it` below states explicitly why it is RED today and why it should pass
 * after the fix.
 */

/**
 * Future-shape of the projector params with the `onTokenUsage` callback the
 * fix will add. Defined locally so the test compiles today without modifying
 * production code. After the fix lands, this `type` can be removed and the
 * test can call `createAcpReplyProjector` directly with `onTokenUsage`.
 */
type AcpTokenUsage = {
  used: number;
  size: number;
  total: number;
};

type AcpProjectorParamsWithUsage = Parameters<typeof createAcpReplyProjector>[0] & {
  onTokenUsage?: (usage: AcpTokenUsage) => void | Promise<void>;
};

type CreateAcpProjectorWithUsage = (
  params: AcpProjectorParamsWithUsage,
) => ReturnType<typeof createAcpReplyProjector>;

/**
 * Cast the production factory through the future-shape param type. The runtime
 * value is unchanged — this is purely a compile-time shim so we can pass
 * `onTokenUsage` without `any` and without editing production code.
 */
const createProjector: CreateAcpProjectorWithUsage =
  createAcpReplyProjector as unknown as CreateAcpProjectorWithUsage;

type Delivery = { kind: string; text?: string };

function createHarness(params?: {
  cfgOverrides?: Parameters<typeof createCfg>[0];
  onTokenUsage?: (usage: AcpTokenUsage) => void | Promise<void>;
}) {
  const deliveries: Delivery[] = [];
  const projector = createProjector({
    cfg: createCfg(params?.cfgOverrides),
    shouldSendToolSummaries: true,
    deliver: async (kind, payload) => {
      deliveries.push({ kind, text: payload.text });
      return true;
    },
    onTokenUsage: params?.onTokenUsage,
  });
  return { deliveries, projector };
}

describe("createAcpReplyProjector — usage_update token capture (catalog #21)", () => {
  // RED today: production projector does not accept `onTokenUsage`, and even
  // if it did the `usage_update` handler at acp-projector.ts:462-474 only
  // hashes `used`/`size` for dedupe — it never invokes any structured callback.
  //
  // Expected GREEN after fix: the projector exposes the captured numeric token
  // usage through the `onTokenUsage` callback exactly once, with the right
  // shape, on a single `usage_update` event carrying `used`/`size`.
  it("RED: surfaces structured token data from usage_update via onTokenUsage", async () => {
    const onTokenUsage = vi.fn<(usage: AcpTokenUsage) => void>();
    const { projector } = createHarness({ onTokenUsage });

    await projector.onEvent({
      type: "status",
      text: "usage updated: 1500/4096",
      tag: "usage_update",
      used: 1500,
      size: 4096,
    });
    await projector.flush(true);

    expect(
      onTokenUsage,
      "Projector dropped numeric used/size from usage_update — see acp-projector.ts:462-474. " +
        "Fix should call onTokenUsage with the parsed numbers so the dispatcher can " +
        "persist them into the acpx record's cumulative_token_usage.",
    ).toHaveBeenCalledTimes(1);
    expect(onTokenUsage).toHaveBeenCalledWith({
      used: 1500,
      size: 4096,
      total: 1500,
    });
  });

  // RED today: same root cause as above. This scenario simulates the real
  // dispatcher integration shape — the dispatcher would capture token usage
  // into a record-shaped object on each turn end, then write it through to the
  // acpx session record.
  //
  // We model the persistence target as a local `acpxRecord` whose
  // `cumulative_token_usage.total` should reflect the most recent usage_update.
  // Today nothing wires usage data into it. After the fix, the projector's
  // `onTokenUsage` callback feeds the shape directly into the persistence
  // bucket, mirroring how the dispatcher fix will write the acpx record.
  //
  // Expected GREEN after fix: `acpxRecord.cumulative_token_usage.total === 1500`.
  it("RED (fix-shape): persistence bucket receives cumulative_token_usage on turn end", async () => {
    type AcpxRecordShape = {
      cumulative_token_usage: { total?: number; size?: number };
    };
    const acpxRecord: AcpxRecordShape = { cumulative_token_usage: {} };

    const onTokenUsage = (usage: AcpTokenUsage) => {
      acpxRecord.cumulative_token_usage = {
        total: usage.total,
        size: usage.size,
      };
    };
    const { projector } = createHarness({ onTokenUsage });

    await projector.onEvent({
      type: "status",
      text: "usage updated: 1500/4096",
      tag: "usage_update",
      used: 1500,
      size: 4096,
    });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });

    expect(
      acpxRecord.cumulative_token_usage.total,
      "acpx record's cumulative_token_usage.total stayed unset because the projector " +
        "never invoked onTokenUsage. Fix shape: projector calls onTokenUsage with parsed " +
        "{ used, size, total }, dispatch-acp.ts persists into SessionAcpMeta and writes the " +
        "acpx record on turn-end.",
    ).toBe(1500);
    expect(acpxRecord.cumulative_token_usage.size).toBe(4096);
  });

  // GREEN control: tool_call events have nothing to do with usage. The
  // callback must NOT fire. This proves the test is sharp — failures of the
  // RED tests cannot be explained by the callback being trigger-happy.
  //
  // GREEN today AND GREEN after fix: the projector should never invoke
  // `onTokenUsage` for non-usage events. Today the callback isn't even
  // accepted, so it never fires; after the fix, the callback is plumbed only
  // for `usage_update`-tagged status events with numeric used/size.
  it("GREEN control: tool_call event does NOT invoke onTokenUsage", async () => {
    const onTokenUsage = vi.fn<(usage: AcpTokenUsage) => void>();
    const { projector } = createHarness({
      cfgOverrides: {
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            tagVisibility: { tool_call: true },
          },
        },
      } as Parameters<typeof createCfg>[0],
      onTokenUsage,
    });

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_no_usage",
      status: "in_progress",
      title: "Run command",
      text: "Run command (in_progress)",
    });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });

    expect(
      onTokenUsage,
      "tool_call must not trigger token-usage capture — only usage_update with numeric " +
        "used/size should. If this fires, the fix's tag check is too broad.",
    ).not.toHaveBeenCalled();
  });
});
