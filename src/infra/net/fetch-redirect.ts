export class GuardedFetchRedirectError extends Error {
  readonly status: number;
  readonly maxRedirects: number;

  constructor(params: { status: number; maxRedirects: number }) {
    super(`Too many redirects (limit: ${params.maxRedirects})`);
    this.name = "GuardedFetchRedirectError";
    this.status = params.status;
    this.maxRedirects = params.maxRedirects;
  }
}

export function getRedirectVisitKey(url: string, init: RequestInit | undefined): string {
  return `${init?.method?.toUpperCase() ?? "GET"} ${url}`;
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
