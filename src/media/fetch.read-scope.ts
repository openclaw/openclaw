import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import {
  captureChannelReadScope,
  withChannelReadAuthority,
} from "../shared/channel-read-authority.js";

type MediaReadOptions = {
  assertCurrent?: () => void;
  beforeRequest?: GuardedFetchOptions["beforeRequest"];
  requestInit?: RequestInit;
};

export async function withMediaReadScope<T extends MediaReadOptions, R>(
  options: T,
  run: (options: T) => Promise<R>,
): Promise<R> {
  if (!captureChannelReadScope() && !options.assertCurrent) {
    return await run(options);
  }
  // Keep request cancellation active through MIME detection, publication, and retries.
  return await withChannelReadAuthority(
    options.assertCurrent ?? (() => {}),
    async () => {
      const scope = captureChannelReadScope()!;
      const beforeRequest = options.beforeRequest;
      return await run({
        ...options,
        beforeRequest: options.assertCurrent
          ? () => {
              scope.assertCurrent();
              return beforeRequest?.();
            }
          : beforeRequest,
        requestInit: { ...options.requestInit, signal: scope.signal },
      });
    },
    options.requestInit?.signal ?? undefined,
  );
}
