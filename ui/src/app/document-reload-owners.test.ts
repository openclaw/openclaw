import { afterEach, expect, it, vi } from "vitest";
import { CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";

afterEach(() => {
  document.documentElement.removeAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE);
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("retains unsaved starts when a terminal policy change would reload the document", async () => {
  vi.resetModules();
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { origin: "http://localhost", reload } });
  const { registerControlUiReloadGuard } = await import("./document-reload-guard.ts");
  const release = registerControlUiReloadGuard(() => false, vi.fn());
  try {
    document.documentElement.setAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE, "false");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ terminalEnabled: true })),
    );
    const { createApplicationConfigCapability } = await import("./config.ts");
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    const attempt = async (terminalEnabled: boolean) => {
      const result = await config.refresh();
      expect(result).toMatchObject({ terminalEnabled });
      // The existing document keeps its policy until a fresh document can load.
      expect(config.current.terminalEnabled).toBe(false);
      return result;
    };
    await attempt(false);
    expect(reload).not.toHaveBeenCalled();
    release();
    await attempt(true);
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});
