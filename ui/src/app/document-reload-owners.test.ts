import { afterEach, expect, it, vi } from "vitest";
import {
  CONTROL_UI_BASE_PATH_ATTRIBUTE,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createFetchServiceWorker } from "./service-worker-cache.test-support.ts";

afterEach(() => {
  document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
  document.documentElement.removeAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE);
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("keeps Terminal disabled after offline-shell recovery until a guarded refresh can reload", async () => {
  vi.resetModules();
  const worker = createFetchServiceWorker();
  worker.fetch.mockImplementation(async () => new Response("build asset"));
  await worker.install();
  worker.fetch.mockResolvedValue(new Response("Gateway unavailable", { status: 503 }));
  const response = await worker.dispatch({
    url: worker.scope + "settings/connection",
    mode: "navigate",
  });
  expect(response?.status).toBe(200);
  const csp = response?.headers.get("Content-Security-Policy");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("'wasm-unsafe-eval'");
  const offlineDocument = new DOMParser().parseFromString(
    (await response?.text()) ?? "",
    "text/html",
  );
  for (const attribute of offlineDocument.documentElement.attributes) {
    document.documentElement.setAttribute(attribute.name, attribute.value);
  }
  const reload = vi.fn();
  vi.stubGlobal("window", {
    location: { origin: new URL(worker.scope).origin, reload },
    dispatchEvent: window.dispatchEvent.bind(window),
  });
  const { registerControlUiReloadGuard } = await import("./document-reload-guard.ts");
  const release = registerControlUiReloadGuard(() => false, vi.fn());
  try {
    const fetch = vi.fn(async () => Response.json({ terminalEnabled: false }));
    vi.stubGlobal("fetch", fetch);
    const { createApplicationConfigCapability } = await import("./config.ts");
    const config = createApplicationConfigCapability({
      resourceBasePath: document.documentElement.getAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE) ?? "",
    });
    await config.refresh();
    expect(reload).not.toHaveBeenCalled();
    expect(config.current.terminalEnabled).toBe(false);
    fetch.mockImplementation(async () => Response.json({ terminalEnabled: true }));
    const attempt = async () => {
      const result = await config.refresh();
      expect(result).toMatchObject({ terminalEnabled: true });
      // The existing document keeps its policy until a fresh document can load.
      expect(config.current.terminalEnabled).toBe(false);
      return result;
    };
    await attempt();
    expect(reload).not.toHaveBeenCalled();
    release();
    expect(reload).not.toHaveBeenCalled();
    await attempt();
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});
