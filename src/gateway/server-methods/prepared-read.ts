import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

/** Authority belongs to each reader; only run's successful response may be shared. */
export type GatewayPreparedRead = {
  shareable?: boolean;
  run: (respond: RespondFn) => Promise<void> | void;
  assertCurrent?: () => void;
  respond?: RespondFn;
  release?: (outcome: "returned" | "threw") => void;
  beforeRespond?: () => void;
};

export type GatewayReadPreparation = (
  options: GatewayRequestHandlerOptions,
) => Promise<GatewayPreparedRead | undefined> | GatewayPreparedRead | undefined;

export type GatewayReadErrorHandler = (
  error: unknown,
  options: GatewayRequestHandlerOptions,
) => void;

export async function withPreparedGatewayRead(
  handler: GatewayRequestHandler,
  options: GatewayRequestHandlerOptions,
  consume: (read: GatewayPreparedRead) => Promise<void>,
): Promise<void> {
  let read: GatewayPreparedRead | undefined;
  let outcome: "returned" | "threw" = "returned";
  try {
    read = handler.prepareRead
      ? await handler.prepareRead(options)
      : { run: (respond) => handler({ ...options, respond }) };
    if (read) {
      await consume(read);
    }
  } catch (error) {
    outcome = "threw";
    if (!handler.onReadError) {
      throw error;
    }
    handler.onReadError(error, options);
  } finally {
    read?.release?.(outcome);
  }
}

/** Direct internal callers and dispatcher readers use the same preparation and cleanup. */
export function createPreparedReadHandler(
  prepareRead: GatewayReadPreparation,
  onReadError?: GatewayReadErrorHandler,
) {
  const handler = Object.assign(
    async (options: GatewayRequestHandlerOptions): Promise<void> =>
      withPreparedGatewayRead(handler, options, async (read) => {
        await read.run((...response) => {
          if (response[0]) {
            read.assertCurrent?.();
            read.beforeRespond?.();
          }
          (read.respond ?? options.respond)(...response);
        });
      }),
    { prepareRead, onReadError },
  );
  return handler;
}
