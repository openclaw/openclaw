import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { ChannelWizardHost } from "./wizard-host.ts";

describe("ChannelWizardHost connection admission", () => {
  it("keeps local wizard input and close available without sending through a retained offline client", async () => {
    const request = vi.fn(async () => ({
      sessionId: "setup-1",
      done: false,
      step: { id: "token", type: "text", title: "Token" },
    }));
    const context = {
      gateway: { snapshot: { phase: "connected", client: { request } } },
      runtimeConfig: { state: { configFormDirty: false } },
      channels: { refresh: vi.fn(), state: {} },
    } as unknown as ApplicationContext;
    const ready = createDeferred();
    const clearSelection = vi.fn();
    const host = new ChannelWizardHost({
      getContext: () => context,
      requestUpdate: () => {
        if (host.state.phase === "step") {
          ready.resolve();
        }
      },
      clearSelection,
    });
    host.startSetup("telegram");
    await ready.promise;
    expect(request).toHaveBeenCalledWith("wizard.start", { flow: "channels", channel: "telegram" });
    request.mockClear();
    clearSelection.mockClear();
    context.gateway.snapshot.phase = "offline";

    host.setTextValue("local draft");
    host.toggleSecretVisibility();
    host.answer("local draft");
    expect(host.textValue).toBe("local draft");
    expect(host.secretVisible).toBe(true);
    expect(host.state).toMatchObject({ phase: "step", busy: false });
    host.startSetup("discord");
    expect(clearSelection).not.toHaveBeenCalled();
    host.close();
    expect(host.state.phase).toBe("idle");
    expect(request).not.toHaveBeenCalled();
  });
});
