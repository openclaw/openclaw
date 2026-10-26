import { assertProviderAuthAuthority } from "../plugins/provider-auth-authority.js";
import { getModelTransportContext } from "./model-transport-context.js";
import { createProviderRateLimitRequest } from "./provider-rate-limit.js";
import type {
  AssistantMessage,
  AssistantMessageEventStreamLike,
  Model,
  SimpleStreamOptions,
} from "./types.js";

/** Admission observes terminal failures but never replays a provider request. */
export async function admitProviderRateLimitStream(
  model: Model,
  options: SimpleStreamOptions | undefined,
  start: (
    options: SimpleStreamOptions,
  ) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>,
  assertCurrent?: () => void,
): Promise<AssistantMessageEventStreamLike> {
  const request = createProviderRateLimitRequest(model, options ?? {});
  const context = getModelTransportContext();
  await request.wait(context?.onRateLimitWait, context?.priority);
  assertCurrent?.();
  assertProviderAuthAuthority(model);
  options?.signal?.throwIfAborted();
  const stream = await start(request.options);
  let observer: typeof request.observe | undefined = request.observe;
  const observe = (message: AssistantMessage) => {
    const pending = observer;
    observer = undefined;
    pending?.(message);
  };
  // Keep native producer completion identity for idle guards and repair consumers.
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  const result = stream.result.bind(stream);
  stream[Symbol.asyncIterator] = async function* () {
    for await (const event of { [Symbol.asyncIterator]: iterate }) {
      if (event.type === "error") {
        observe(event.error);
      } else if (event.type === "done") {
        observe(event.message);
      }
      yield event;
    }
  };
  stream.result = async () => {
    try {
      const message = await result();
      observe(message);
      return message;
    } finally {
      observer = undefined;
    }
  };
  return stream;
}
