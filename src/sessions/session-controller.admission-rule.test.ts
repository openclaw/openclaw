import { afterEach, expect, it } from "vitest";
import { evaluateTurnAdmission } from "./session-controller.admission-rule.js";
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
  options: Partial<Parameters<typeof evaluateTurnAdmission>[1]> = {},
) {
  return evaluateTurnAdmission(entry, {
    kind: "visible",
    sessionKey: entry.key,
    registeredEntry: sessionControllers.get(entry.id),
    ...options,
  });
}

afterEach(() => {
  sessionControllers.clear();
});

it.each(
  Object.entries({
    active: (entry) => {
      entry.active = {} as NonNullable<SessionControllerEntry["active"]>;
    },
    "successor-barrier": (entry) => {
      entry.successorBarrier = {} as NonNullable<SessionControllerEntry["successorBarrier"]>;
    },
    "lifecycle-blocked": (entry) => {
      entry.lifecycle = { blocksTurnAdmission: true } as SessionControllerEntry["lifecycle"];
    },
    "waiting-inputs": (entry) => {
      reserveSessionControllerSource(entry.key, { policy: { mode: "followup" } });
    },
    "stale-claim": (entry) => {
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
    "entry-retired": (entry) => {
      sessionControllers.delete(entry.id);
    },
    "mailbox-clearing": (entry) => {
      getSessionControllerMailbox(entry.key).clearing = true;
    },
  } satisfies Record<
    Exclude<TurnAdmissionRefusalReason, "followup-barrier">,
    (entry: SessionControllerEntry) => SessionControllerMailboxClaim | void
  >),
)("reports %s", (reason, arrange) => {
  const entry = createEntry(reason);
  const claim = arrange(entry);
  expect(evaluate(entry, { claim: claim ?? undefined })).toEqual({ admitted: false, reason });
});

it("retains a mailbox while a consumed input finishes cleanup", () => {
  const entry = createEntry("consumed-input");
  const input = reserveSessionControllerSource(entry.key, { policy: { mode: "followup" } });
  input.phase = "consumed";
  expect(evaluate(entry, { kind: "direct", selectedInput: null })).toEqual({
    admitted: false,
    reason: "waiting-inputs",
  });
});
