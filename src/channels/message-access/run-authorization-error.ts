import { collectErrorGraphCandidates } from "@openclaw/normalization-core/error-coercion";

/** A channel rejected source authorization before the model could execute. */
export class ChannelRunAuthorizationError extends Error {
  constructor(
    cause: unknown,
    readonly disposition: "denied" | "unavailable" = "denied",
  ) {
    super("Channel authorization could not be renewed before run admission", { cause });
    this.name = "ChannelRunAuthorizationError";
  }
}

export function isChannelRunAuthorizationError(
  error: unknown,
  disposition?: ChannelRunAuthorizationError["disposition"],
): boolean {
  return collectErrorGraphCandidates(error).some(
    (candidate) =>
      candidate instanceof ChannelRunAuthorizationError &&
      (disposition === undefined || candidate.disposition === disposition),
  );
}
