import type { AuthorityEvent } from "../../../packages/openclaw-id-protocol/src/index.js";

/** A refused write: a stable code the UI matches, and detail for logs. */
export type AuthorityRefusal = {
  ok: false;
  code: string;
  detail: string;
};

/** Accepted write and the effects to perform. */
export type AuthorityAccepted = {
  ok: true;
  status: "applied" | "pending";
  events: AuthorityEvent[];
};
