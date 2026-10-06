import type { GatewayEventFrame } from "../../api/gateway.ts";
import {
  classifyCustodianHealthNudge,
  shouldConsumeNudge,
  type CustodianEventNudge,
  type CustodianSendOutcome,
} from "./event-nudge.ts";
import type { CustodianSessionVariant } from "./session-lifecycle.ts";

interface CustodianNudgeOwner {
  eventNudge: CustodianEventNudge | null;
  eventNudgePending: CustodianEventNudge | null;
  eventNudgeClosed: boolean;
  readonly sensitive: boolean;
  readonly activeVariant: CustodianSessionVariant;
  hasUnresolvedQuestion(): boolean;
  send(text: string): Promise<CustodianSendOutcome>;
  requestNudgeUpdate(): void;
}

export function receiveEventNudge(owner: CustodianNudgeOwner, event: GatewayEventFrame): void {
  if (owner.activeVariant !== "caretaker" || owner.eventNudgeClosed) {
    return;
  }
  if (event.event === "health") {
    owner.eventNudge = classifyCustodianHealthNudge(event.payload);
  }
  owner.requestNudgeUpdate();
}

export async function sendEventNudge(owner: CustodianNudgeOwner): Promise<void> {
  const nudge = owner.eventNudge;
  if (!nudge || owner.sensitive || owner.hasUnresolvedQuestion()) {
    return;
  }
  owner.eventNudgePending = nudge;
  owner.requestNudgeUpdate();
  const outcome = await owner.send(nudge.message);
  if (owner.eventNudgePending === nudge) {
    owner.eventNudgePending = null;
    const consumed = shouldConsumeNudge(owner.eventNudge, nudge, outcome);
    [owner.eventNudgeClosed, owner.eventNudge] = [consumed, consumed ? null : owner.eventNudge];
    owner.requestNudgeUpdate();
  }
}

export function dismissEventNudge(owner: CustodianNudgeOwner): void {
  [owner.eventNudge, owner.eventNudgeClosed] = [null, true];
  owner.requestNudgeUpdate();
}
