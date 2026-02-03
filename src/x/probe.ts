/**
 * X channel probe - verify credentials are valid.
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import { TwitterApi } from "twitter-api-v2";
import type { XAccountConfig } from "./types.js";

export interface XProbeResult {
  ok: boolean;
  user?: {
    id: string;
    username: string;
    name: string;
  };
  error?: string;
  elapsedMs: number;
}

/**
 * Probe X credentials by fetching the authenticated user.
 */
export async function probeX(account: XAccountConfig, timeoutMs: number): Promise<XProbeResult> {
  const start = Date.now();

  try {
    if (!account.consumerKey || !account.consumerSecret) {
      return {
        ok: false,
        error: "Missing consumer key/secret",
        elapsedMs: Date.now() - start,
      };
    }
    if (!account.accessToken || !account.accessTokenSecret) {
      return {
        ok: false,
        error: "Missing access token/secret",
        elapsedMs: Date.now() - start,
      };
    }

    // Configure proxy agent if proxy URL is set
    const httpAgent = account.proxy ? new HttpsProxyAgent(account.proxy) : undefined;

    const client = new TwitterApi(
      {
        appKey: account.consumerKey,
        appSecret: account.consumerSecret,
        accessToken: account.accessToken,
        accessSecret: account.accessTokenSecret,
      },
      httpAgent ? { httpAgent } : undefined,
    );

    // Use AbortController for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const me = await client.v2.me({
        "user.fields": ["id", "username", "name"],
      });

      clearTimeout(timeout);

      return {
        ok: true,
        user: {
          id: me.data.id,
          username: me.data.username,
          name: me.data.name,
        },
        elapsedMs: Date.now() - start,
      };
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: errorMsg,
      elapsedMs: Date.now() - start,
    };
  }
}
