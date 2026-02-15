import { describe, expect, it, vi } from "vitest";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core dialog errors", () => {
  it("swallows errors when dialog.accept fails (e.g. dialog already closed)", async () => {
    const error = new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");
    const accept = vi.fn(async () => {
      throw error;
    });
    const dismiss = vi.fn(async () => {});
    const dialog = { accept, dismiss };
    
    // waitForEvent resolves successfully with the dialog
    const waitForEvent = vi.fn(async () => dialog);
    
    setPwToolsCoreCurrentPage({
      waitForEvent,
    });

    // Should not throw
    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: true,
      promptText: "x",
    });
    
    expect(accept).toHaveBeenCalledWith("x");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("swallows errors when dialog.dismiss fails", async () => {
    const error = new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");
    const accept = vi.fn(async () => {});
    const dismiss = vi.fn(async () => {
      throw error;
    });
    const dialog = { accept, dismiss };
    
    const waitForEvent = vi.fn(async () => dialog);
    
    setPwToolsCoreCurrentPage({
      waitForEvent,
    });

    // Should not throw
    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: false,
    });
    
    expect(dismiss).toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});
