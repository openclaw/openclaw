import { afterEach, describe, expect, it } from "vitest";
import { evaluateTurnAdmission } from "./session-controller.admission-rule.js";
import type { SessionControllerTurnKind } from "./session-controller.contracts.js";
import {
  getSessionControllerMailbox,
  reserveSessionControllerSource,
  type SessionControllerMailboxClaim,
} from "./session-controller.mailbox.js";
import {
  getSessionControllerEntry,
  sessionControllers,
  type SessionControllerEntry,
} from "./session-controller.state.js";

type TurnAdmissionRefusalReason = Extract<
  ReturnType<typeof evaluateTurnAdmission>,
  { admitted: false }
>["reason"];

function createEntry(label: string): SessionControllerEntry {
  return getSessionControllerEntry(`agent:main:admission-rule:${label}`);
}

function evaluate(
  entry: SessionControllerEntry,
  kind: SessionControllerTurnKind = "visible",
  claim?: SessionControllerMailboxClaim,
) {
  return evaluateTurnAdmission(entry, {
    kind,
    sessionKey: entry.key,
    registeredEntry: sessionControllers.get(entry.id),
    claim,
  });
}

function barrier(): NonNullable<SessionControllerEntry["followupBarrier"]> {
  return {} as NonNullable<SessionControllerEntry["followupBarrier"]>;
}

function state(
  mutate: (entry: SessionControllerEntry) => void,
): (entry: SessionControllerEntry) => SessionControllerMailboxClaim | undefined {
  return (entry) => {
    mutate(entry);
    return undefined;
  };
}

afterEach(() => {
  sessionControllers.clear();
});

describe("evaluateTurnAdmission", () => {
  it("admits an idle current entry", () => {
    const entry = createEntry("idle");
    expect(evaluate(entry)).toEqual({ admitted: true });
  });

  it.each([
    {
      reason: "active",
      arrange: state((entry) => {
        entry.active = {} as NonNullable<SessionControllerEntry["active"]>;
      }),
    },
    {
      reason: "successor-barrier",
      arrange: state((entry) => {
        entry.successorBarrier = barrier();
      }),
    },
    {
      reason: "lifecycle-blocked",
      arrange: state((entry) => {
        entry.lifecycle = { blocksTurnAdmission: true } as SessionControllerEntry["lifecycle"];
      }),
    },
    {
      reason: "waiting-inputs",
      arrange: state((entry) => {
        reserveSessionControllerSource(entry.key, { policy: { mode: "followup" } });
      }),
    },
    {
      reason: "stale-claim",
      arrange: (entry: SessionControllerEntry) => {
        const mailbox = getSessionControllerMailbox(entry.key);
        const claim = {
          mailbox,
          inputs: [],
          sources: [],
          summary: false,
          custody: {},
          released: true,
          settlement: {} as SessionControllerMailboxClaim["settlement"],
          abortController: new AbortController(),
        } satisfies SessionControllerMailboxClaim;
        mailbox.claim = claim;
        return claim;
      },
    },
    {
      reason: "entry-retired",
      arrange: state((entry) => {
        sessionControllers.delete(entry.id);
      }),
    },
    {
      reason: "mailbox-clearing",
      arrange: state((entry) => {
        getSessionControllerMailbox(entry.key).clearing = true;
      }),
    },
  ] satisfies ReadonlyArray<{
    reason: TurnAdmissionRefusalReason;
    arrange: (entry: SessionControllerEntry) => SessionControllerMailboxClaim | undefined;
  }>)("reports $reason", ({ reason, arrange }) => {
    const entry = createEntry(reason);
    const claim = arrange(entry);
    expect(evaluate(entry, "visible", claim)).toEqual({ admitted: false, reason });
  });

  it.each([
    { kind: "visible", admitted: true },
    { kind: "heartbeat", admitted: false },
    { kind: "queued_followup", admitted: false },
    { kind: "direct", admitted: true },
  ] as const)("applies delivery admission for $kind (admitted=$admitted)", ({ kind, admitted }) => {
    const entry = createEntry(`barrier-${kind}`);
    entry.followupBarrier = barrier();
    expect(evaluate(entry, kind)).toEqual(
      admitted ? { admitted: true } : { admitted: false, reason: "followup-barrier" },
    );
  });

  it("retains a mailbox while a consumed input finishes cleanup", () => {
    const entry = createEntry("consumed-input");
    const input = reserveSessionControllerSource(entry.key, { policy: { mode: "followup" } });
    input.phase = "consumed";
    expect(
      evaluateTurnAdmission(entry, {
        kind: "direct",
        sessionKey: entry.key,
        registeredEntry: entry,
        selectedInput: null,
      }),
    ).toEqual({ admitted: false, reason: "waiting-inputs" });
  });
});
