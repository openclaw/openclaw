// Serialized into the page with the mock Gateway. Keep every dependency explicit.
export function createControlUiMockDeferredRequests<
  TResponse extends { method: string; params?: unknown },
>(
  input: {
    deferredMethods: string[];
    deferredRequests: Array<{
      method: string;
      match?: Record<string, unknown>;
      exactParams?: boolean;
    }>;
    heldMethods: string[];
    heldRequests: Array<{
      method: string;
      match?: Record<string, unknown>;
      exactParams?: boolean;
    }>;
  },
  matches: (params: unknown, match?: Record<string, unknown>) => boolean,
  matchesExact: (actual: unknown, expected: unknown) => boolean,
) {
  type Selector = {
    method: string;
    match?: Record<string, unknown>;
    exactParams?: boolean;
  };
  const deferred: Selector[] = [
    ...input.deferredMethods.map((method) => ({ method })),
    ...input.deferredRequests,
  ];
  const held: Selector[] = [
    ...input.heldMethods.map((method) => ({ method })),
    ...input.heldRequests,
  ];
  const responses: TResponse[] = [];

  const matchesSelector = (params: unknown, selector: Omit<Selector, "method">) =>
    selector.exactParams === true
      ? matchesExact(params, selector.match ?? {})
      : matches(params, selector.match);

  return {
    responses,
    matches: matchesSelector,
    defer(selector: Selector) {
      deferred.push(selector);
    },
    shouldDefer(method: string, params: unknown) {
      if (
        held.some((candidate) => candidate.method === method && matchesSelector(params, candidate))
      ) {
        return true;
      }
      const index = deferred.findIndex(
        (candidate) => candidate.method === method && matchesSelector(params, candidate),
      );
      if (index < 0) {
        return false;
      }
      deferred.splice(index, 1);
      return true;
    },
    take(method: string, options?: { match?: Record<string, unknown>; exactParams?: boolean }) {
      const selector = { method, ...options };
      const index = responses.findIndex(
        (response) => response.method === method && matchesSelector(response.params, selector),
      );
      if (index < 0) {
        throw new Error(`No deferred mock Gateway response for ${method}`);
      }
      const heldIndex = held.findIndex(
        (candidate) =>
          candidate.method === method &&
          candidate.exactParams === selector.exactParams &&
          matchesExact(candidate.match, selector.match),
      );
      if (heldIndex < 0) {
        return responses.splice(index, 1);
      }
      held.splice(heldIndex, 1);
      const selected = responses.filter(
        (response) => response.method === method && matchesSelector(response.params, selector),
      );
      for (let i = responses.length - 1; i >= 0; i -= 1) {
        const response = responses[i];
        if (response?.method === method && matchesSelector(response.params, selector)) {
          responses.splice(i, 1);
        }
      }
      return selected;
    },
  };
}
