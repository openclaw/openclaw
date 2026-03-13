const fetchTransportHintsSymbol = Symbol.for("openclaw.fetch.transport-hints");

export type FetchTransportHints = {
  connect?: Record<string, unknown>;
};

type FetchWithTransportHints = typeof fetch & {
  [fetchTransportHintsSymbol]?: FetchTransportHints;
};

export function attachFetchTransportHints(
  fetchImpl: typeof fetch,
  hints: FetchTransportHints,
): typeof fetch {
  const next = fetchImpl as FetchWithTransportHints;
  Object.defineProperty(next, fetchTransportHintsSymbol, {
    value: hints,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return fetchImpl;
}

export function readFetchTransportHints(fetchImpl?: typeof fetch): FetchTransportHints | undefined {
  return (fetchImpl as FetchWithTransportHints | undefined)?.[fetchTransportHintsSymbol];
}
