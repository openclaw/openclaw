import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

const RETIRED_METHOD_GROUPS = [
  [
    "Skill Workshop proposals are retired. Workshop changes apply immediately and are undoable: use skills.workshop.list/changes/read/archive/restore (CLI: openclaw skills workshop ...).",
    [
      "skills.proposals.list",
      "skills.proposals.inspect",
      "skills.proposals.historyStatus",
      "skills.proposals.historyScan",
      "skills.proposals.create",
      "skills.proposals.update",
      "skills.proposals.revise",
      "skills.proposals.requestRevision",
      "skills.proposals.apply",
      "skills.proposals.reject",
      "skills.proposals.quarantine",
      "skills.proposals.events.list",
      "skills.proposals.evaluate",
    ],
  ],
  [
    "Skill curator methods are retired. Use skills.workshop.list for Workshop skills, usage, and saved versions, and skills.workshop.archive/restore to change them (CLI: openclaw skills workshop ...).",
    [
      "skills.curator.status",
      "skills.curator.pin",
      "skills.curator.unpin",
      "skills.curator.restore",
    ],
  ],
] as const;

/** Retired methods stay registered (the catalog is append-only) so old clients get guidance. */
export const skillsRetiredHandlers: GatewayRequestHandlers = Object.fromEntries(
  RETIRED_METHOD_GROUPS.flatMap(([message, methods]) =>
    methods.map((method): [string, GatewayRequestHandler] => [
      method,
      ({ respond }) => respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message)),
    ]),
  ),
);
