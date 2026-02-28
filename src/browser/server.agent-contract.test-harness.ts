import { fetch as realFetch } from "undici";
import {
  getBrowserControlServerBaseUrl,
  installBrowserControlServerHooks,
  startBrowserControlServerFromConfig,
} from "./server.control-server.test-harness.js";

export function installAgentContractHooks() {
  installBrowserControlServerHooks();
}

export async function startServerAndBase(): Promise<string> {
  await startBrowserControlServerFromConfig();
  const base = getBrowserControlServerBaseUrl();
  await realFetch(`${base}/start`, { method: "POST" }).then((r) => r.json());
  return base;
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await realFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
