// Shared dependency surface for CLI send commands.
import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";

/** CLI dependency bag currently used by outbound send command plumbing. */
export type CliDeps = OutboundSendDeps;
