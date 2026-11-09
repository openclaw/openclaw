import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { AsyncContext } from "../../shared/async-context.js";

type RequestAuthority = { assertCurrent: () => void; beforeRequest?: () => void };

// Host runtime and plugin SDK chunks must retain the same request-owned fence.
const requestAuthority = new AsyncContext<RequestAuthority>(
  Symbol.for("openclaw.guardedFetchRequestAuthority"),
);

/** Egress-only checks require managed fetch; lifetime assertions may also guard native transports. */
export function hasGuardedFetchBeforeRequest(): boolean {
  return requestAuthority.getStore()?.beforeRequest !== undefined;
}

/** Capture before transport preparation so redirects retain the original caller. */
export function captureGuardedFetchRequestAuthority(): (() => void) | undefined {
  const authority = requestAuthority.getStore();
  return authority
    ? () => {
        authority.assertCurrent();
        authority.beforeRequest?.();
      }
    : undefined;
}

function invokeSynchronousGuard(guard: (() => void) | undefined): void {
  const result: unknown = guard?.();
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => undefined);
    throw new TypeError("Guarded request authority must be synchronous.");
  }
}

/**
 * Add a synchronous egress check to guarded requests started by run, including
 * requests a returned stream sends later. It narrows inherited authority only.
 */
export function withGuardedFetchBeforeRequest<T>(
  beforeRequest: (() => void) | undefined,
  run: () => T,
): T {
  if (!beforeRequest) {
    return run();
  }
  const inherited = requestAuthority.getStore();
  return requestAuthority.run(
    {
      assertCurrent: () => inherited?.assertCurrent(),
      beforeRequest: () => {
        inherited?.beforeRequest?.();
        invokeSynchronousGuard(beforeRequest);
      },
    },
    run,
  );
}

// Retained guards must not share the async producer's lexical frame.
function createRequestAuthority(source: {
  assertCurrent: (() => void) | undefined;
  beforeRequest: (() => void) | undefined;
  inherited: RequestAuthority | undefined;
}) {
  let active = true;
  const assertAuthority = () => {
    source.inherited?.assertCurrent();
    if (!active) {
      throw new Error("Guarded request authority is no longer active.");
    }
    invokeSynchronousGuard(source.assertCurrent);
  };
  return {
    assertCurrent: assertAuthority,
    beforeRequest:
      source.beforeRequest || source.inherited?.beforeRequest
        ? () => {
            source.inherited?.beforeRequest?.();
            invokeSynchronousGuard(source.beforeRequest);
          }
        : undefined,
    close() {
      active = false;
      source.inherited = undefined;
      source.assertCurrent = undefined;
      source.beforeRequest = undefined;
    },
  };
}

/** Carry a host-owned assertion through provider preparation without granting new authority. */
export async function withGuardedFetchRequestAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: (assertCurrent: (() => void) | undefined) => Promise<T>,
  beforeRequest?: () => void,
): Promise<T> {
  const inherited = requestAuthority.getStore();
  if (!assertCurrent && !beforeRequest && !inherited) {
    return await run(undefined);
  }
  const authority = createRequestAuthority({ assertCurrent, beforeRequest, inherited });
  try {
    authority.assertCurrent();
    return await requestAuthority.run(authority, () => run(authority.assertCurrent));
  } finally {
    authority.close();
  }
}
