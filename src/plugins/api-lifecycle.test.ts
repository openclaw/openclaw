import { describe, expect, it, vi } from "vitest";
import { runPluginRegisterSync } from "./loader-module-runtime.js";
import type { OpenClawPluginApi } from "./types.js";

// The registration guard silently resolves `undefined` for any api method
// called after register() returns, unless the method is late-callable.
// enqueueNextTurnInjection is a runtime-phase method: queuing an injection
// during register() is pointless (there is nothing to inject yet), so plugins
// only ever call it from tool executors and hook handlers — after the guard
// has closed. Before it was allowlisted, every such call resolved `undefined`
// with no diagnostic, silently dropping the injection.
describe("guarded plugin registration api lifecycle", () => {
  it("keeps enqueueNextTurnInjection callable after register() returns", async () => {
    const enqueue = vi.fn(async (injection: { sessionKey: string; text: string }) => ({
      enqueued: true,
      id: "inj-1",
      sessionKey: injection.sessionKey,
    }));
    let captured: OpenClawPluginApi | undefined;
    runPluginRegisterSync(
      (api) => {
        captured = api;
      },
      { enqueueNextTurnInjection: enqueue } as unknown as OpenClawPluginApi,
    );

    const viaFacade = await captured!.session.workflow.enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "queued after registration",
    });
    expect(viaFacade).toEqual({ enqueued: true, id: "inj-1", sessionKey: "agent:main:main" });

    const viaFlatMethod = await captured!.enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "flat method after registration",
    });
    expect(viaFlatMethod?.enqueued).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("still voids registration-phase methods after register() returns", () => {
    const registerTool = vi.fn(() => "registered");
    let captured: OpenClawPluginApi | undefined;
    runPluginRegisterSync(
      (api) => {
        captured = api;
      },
      { registerTool } as unknown as OpenClawPluginApi,
    );

    expect(captured!.registerTool({} as never)).toBeUndefined();
    expect(registerTool).not.toHaveBeenCalled();
  });
});
