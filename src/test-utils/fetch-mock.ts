type FetchWithPreconnect = {
  preconnect: (url: string, init?: { credentials?: RequestCredentials }) => void;
};

export function withFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
export function withFetchPreconnect<T extends object>(
  fn: T,
): T & FetchWithPreconnect & typeof fetch;
export function withFetchPreconnect(fn: object) {
  return Object.assign(fn, {
    preconnect: (_url: string, _init?: { credentials?: RequestCredentials }) => {},
  });
}
