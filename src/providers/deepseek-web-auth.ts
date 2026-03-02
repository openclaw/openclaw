import { chromium } from "playwright-core";
import { getHeadersWithAuth } from "../browser/cdp.helpers.js";
import {
  launchOpenClawChrome,
  stopOpenClawChrome,
  getChromeWebSocketUrl,
} from "../browser/chrome.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";

export async function loginDeepseekWeb(params: {
  onProgress: (msg: string) => void;
  openUrl: (url: string) => Promise<boolean>;
}) {
  const browserConfig = resolveBrowserConfig(undefined);
  const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
  if (!profile) {
    throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
  }

  params.onProgress("Launching browser...");
  const running = await launchOpenClawChrome(browserConfig, profile);

  try {
    const cdpUrl = `http://127.0.0.1:${running.cdpPort}`;
    let wsUrl: string | null = null;

    // Retry finding the WS URL as Chrome might take a second to populate it
    params.onProgress("Waiting for browser debugger...");
    for (let i = 0; i < 10; i++) {
      wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
      if (wsUrl) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!wsUrl) {
      throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl} after retries.`);
    }

    params.onProgress("Connecting to browser...");
    const browser = await chromium.connectOverCDP(wsUrl, {
      headers: getHeadersWithAuth(wsUrl),
    });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    await page.goto("https://chat.deepseek.com");
    const userAgent = await page.evaluate(() => navigator.userAgent);

    params.onProgress("Please login to DeepSeek in the opened browser window...");

    return await new Promise<{ cookie: string; bearer: string; userAgent: string }>(
      (resolve, reject) => {
        let capturedBearer: string | undefined;
        let resolved = false;

        const timeout = setTimeout(() => {
          if (!resolved) {
            reject(new Error("Login timed out (5 minutes)."));
          }
        }, 300000);

        const tryResolve = async () => {
          if (!capturedBearer || resolved) {
            return;
          }

          try {
            // Get all cookies for the domain
            const cookies = await context.cookies([
              "https://chat.deepseek.com",
              "https://deepseek.com",
            ]);
            if (cookies.length === 0) {
              console.log(`[DeepSeek Research] No cookies found in context yet.`);
              return;
            }

            const cookieNames = cookies.map((c) => c.name);
            console.log(`[DeepSeek Research] Found cookies in context: ${cookieNames.join(", ")}`);

            const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

            // d_id is preferred, but ds_session_id is an extremely strong signal of an active session
            const hasDeviceId = cookieString.includes("d_id=");
            const hasSessionId = cookieString.includes("ds_session_id=");
            const hasSessionInfo =
              cookieString.includes("HWSID=") || cookieString.includes("uuid=");

            if (hasDeviceId || hasSessionId || hasSessionInfo || cookies.length > 3) {
              resolved = true;
              clearTimeout(timeout);
              console.log(
                `[Deepseek Research] All credentials captured via context! (Has d_id: ${hasDeviceId}, Has ds_session_id: ${hasSessionId})`,
              );
              resolve({
                cookie: cookieString,
                bearer: capturedBearer,
                userAgent,
              });
            } else {
              console.log(
                `[DeepSeek Research] Found some cookies, but missing key identifiers (d_id). Continuing to wait...`,
              );
            }
          } catch (e: unknown) {
            console.error(`[DeepSeek Research] Failed to fetch cookies from context: ${String(e)}`);
          }
        };

        page.on("request", async (request) => {
          const url = request.url();
          if (url.includes("/api/v0/")) {
            const headers = request.headers();
            const auth = headers["authorization"];

            if (auth?.startsWith("Bearer ")) {
              if (!capturedBearer) {
                console.log(`[DeepSeek Research] Captured Bearer Token.`);
                capturedBearer = auth.slice(7);
              }
              await tryResolve();
            }

            if (url.includes("/api/v0/chat/completion")) {
              console.log(`[DeepSeek Research] Completion Request Headers Check:`, {
                hasAuth: !!auth,
              });
            }
          }
        });

        page.on("response", async (response) => {
          const url = response.url();
          if (url.includes("/api/v0/") && response.ok()) {
            try {
              const contentType = response.headers()["content-type"];
              if (contentType?.includes("application/json")) {
                const body = (await response.json()) as Record<string, unknown>;
                console.log(
                  `[DeepSeek Research] Response from ${url}:`,
                  JSON.stringify(body).slice(0, 200) + "...",
                );
              }
            } catch {
              // ignore
            }
          }
        });

        page.on("close", () => {
          reject(new Error("Browser window closed before login was captured."));
        });
      },
    );
  } finally {
    await stopOpenClawChrome(running);
  }
}
