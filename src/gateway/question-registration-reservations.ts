import { randomUUID } from "node:crypto";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/index.js";
import { QuestionManagerError, QuestionManagerErrorCodes } from "./question-manager.errors.js";

/** Process-only claim on the manager's global ID namespace during worker registration. */
export type QuestionRegistrationReservation = {
  readonly id: string;
  assertCurrent: () => void;
  release: () => void;
};

export class QuestionRegistrationReservations {
  private readonly claims = new Map<string, QuestionRegistrationReservation>();

  constructor(private readonly isOccupied: (id: string) => boolean) {}

  reserve(id: string = randomUUID()): QuestionRegistrationReservation {
    this.assertAvailable(id);
    const claim: QuestionRegistrationReservation = {
      id,
      assertCurrent: () => {
        if (this.claims.get(id) !== claim) {
          throw new Error("Question registration owner retired");
        }
      },
      release: () => {
        if (this.claims.get(id) === claim) {
          this.claims.delete(id);
        }
      },
    };
    this.claims.set(id, claim);
    return claim;
  }

  assertAvailable(id: string, claim?: QuestionRegistrationReservation): void {
    if (claim) {
      claim.assertCurrent();
      if (claim.id !== id) {
        throw new Error("Question registration ID does not match its owner");
      }
    }
    if (this.isOccupied(id) || (this.claims.has(id) && this.claims.get(id) !== claim)) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ID_IN_USE,
        `question '${id}' already exists`,
      );
    }
  }

  reset(): void {
    this.claims.clear();
  }
}

/** Materialize the manager timing once; stored custody never renews its deadline. */
export function resolveQuestionRequestTiming(
  params: {
    id?: string;
    timeoutMs: number;
    storedRecord?: Pick<QuestionRecord, "id" | "createdAtMs" | "expiresAtMs">;
  },
  nowMs: number,
) {
  const createdAtMs = params.storedRecord?.createdAtMs ?? nowMs;
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const expiresAtMs =
    params.storedRecord?.expiresAtMs ??
    resolveExpiresAtMsFromDurationMs(timeoutMs, { nowMs: createdAtMs });
  if (expiresAtMs === undefined) {
    throw new Error("question expiry is unavailable");
  }
  return { id: params.storedRecord?.id ?? params.id ?? randomUUID(), createdAtMs, expiresAtMs };
}
