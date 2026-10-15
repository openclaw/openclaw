import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { digestClawValue } from "../../claws/digest.js";
import { resolveClawMonitorCleanupBinding } from "../../claws/monitor-cleanup-binding.js";
import { clawRemovalJournalRequestSchema } from "../../claws/removal-journal-contract.js";
import { mutateClawRemovalJournal } from "../../claws/removal-journal.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type JournalRequestOptions = Pick<
  GatewayRequestHandlerOptions,
  "params" | "respond" | "signal" | "sessionMutationCommitGuard" | "hasCurrentClientAuthority"
> & {
  context: Pick<
    GatewayRequestHandlerOptions["context"],
    "getRuntimeConfig" | "isConfigReloadSettled" | "cronStorePath"
  >;
};

export const clawsRemovalJournalHandlers = {
  "claws.removalJournal": async (options: JournalRequestOptions) => {
    const { params, context, respond } = options;
    const parsed = clawRemovalJournalRequestSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Claw removal journal parameters."),
      );
      return;
    }
    const request = parsed.data;
    const config = context.getRuntimeConfig();
    const assertCurrent = () => {
      options.signal?.throwIfAborted();
      options.sessionMutationCommitGuard?.();
      if (
        options.hasCurrentClientAuthority?.() === false ||
        !isDeepStrictEqual(
          request.binding,
          resolveClawMonitorCleanupBinding(context.cronStorePath),
        ) ||
        context.getRuntimeConfig() !== config ||
        digestClawValue(config) !== request.configDigest ||
        !context.isConfigReloadSettled()
      ) {
        throw new Error(
          "Claw removal no longer owns the serving Gateway's configuration or request authority.",
        );
      }
    };
    let dispatched = false;
    try {
      assertCurrent();
      dispatched = true;
      respond(true, await mutateClawRemovalJournal({ request, config }, assertCurrent));
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error), {
          details: { outcomeUnknown: dispatched },
        }),
      );
    }
  },
} satisfies GatewayRequestHandlers;
