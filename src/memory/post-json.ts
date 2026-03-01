import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
  attachStatus?: boolean;
  parse: (payload: unknown) => T | Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    url: params.url,
    ssrfPolicy: params.ssrfPolicy,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
          status?: number;
        };
        if (params.attachStatus) {
          err.status = res.status;
        }
        throw err;
      }
      return await params.parse(await res.json());
    },
  });
}
