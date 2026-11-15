export type AsyncPluginHook<Event, Context, Result = void> = (
  event: Event,
  ctx: Context,
) => Promise<Result | void> | Result | void;
