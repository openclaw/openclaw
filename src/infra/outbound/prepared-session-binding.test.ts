import { afterEach, expect, it, vi } from "vitest";
import { createSqliteCommitReceipt, type SqliteCommitSource } from "../sqlite-commit-receipt.js";
import { currentConversationBindingPublication } from "./current-conversation-bindings.publication.js";
import { prepareSessionBindingSelection } from "./prepared-session-binding.js";
import type {
  SessionBindingAdapter,
  SessionBindingAdapterV2,
  SessionBindingRecord,
} from "./session-binding.types.js";

afterEach(() => vi.restoreAllMocks());

it.each(["unchanged", "published", "unknown", "missing", "receipt", "unknown-facts"] as const)(
  "retains overlapping prepared ownership blockers until %s settlement",
  async (outcome) => {
    type Listener = Parameters<typeof currentConversationBindingPublication.subscribeFacts>[0];
    let notify: Listener = () => {
      throw new Error("Prepared fact listener was not installed");
    };
    const unsubscribe = vi.fn();
    vi.spyOn(currentConversationBindingPublication, "subscribeFacts").mockImplementation(
      (listener) => {
        notify = listener;
        return unsubscribe;
      },
    );
    const conversation = { channel: "fixture", accountId: "default", conversationId: "prepared" };
    const adapter: SessionBindingAdapter = {
      ...conversation,
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    const assertCurrent = vi.fn();
    const prepared = await prepareSessionBindingSelection([conversation], {
      resolveAdapterForChannelAccount: () => adapter,
      assertAdapterSelectionCurrent: assertCurrent,
      isAsyncAdapter: (value): value is SessionBindingAdapterV2 =>
        "version" in value && value.version === 2,
      availableBindingInspection: (_conversation, binding) => ({ status: "available", binding }),
    });
    const first = {};
    const second = {};
    const identity = "prepared-test-database";
    try {
      expect(prepared.inspect()).toEqual([{ status: "available", binding: null }]);
      notify({ kind: "pending", identity, operation: first });
      notify({ kind: "pending", identity, operation: second });
      notify({ kind: "settled", identity, operation: first, outcome: "unchanged" });
      expect(() => prepared.inspect()).toThrow("ownership changed");
      // An unrelated settlement cannot clear the second operation's ownership fence.
      notify({ kind: "settled", identity, operation: {}, outcome: "unchanged" });
      expect(() => prepared.inspect()).toThrow("ownership changed");
      if (outcome === "receipt") {
        notify({
          receipt: createSqliteCommitReceipt<SessionBindingRecord, SqliteCommitSource>({
            source: { identity, incarnation: "prepared-test-incarnation" },
            domain: "current-conversation-bindings",
            keys: ["prepared-reference"],
            readFact: () => ({ kind: "absent" }),
          }),
          sessionKeys: [],
        });
      } else if (outcome === "unknown-facts") {
        notify({ kind: "unknown", identity });
      }
      notify({
        kind: "settled",
        identity,
        operation: second,
        outcome:
          outcome === "receipt" || outcome === "unknown-facts"
            ? "unchanged"
            : outcome === "missing"
              ? undefined
              : outcome,
      });
      if (outcome === "unchanged") {
        expect(prepared.inspect()).toEqual([{ status: "available", binding: null }]);
        expect(assertCurrent).toHaveBeenCalledTimes(2);
      } else {
        expect(() => prepared.inspect()).toThrow("ownership changed");
      }
    } finally {
      prepared.dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(() => prepared.inspect()).toThrow("no longer active");
  },
);
