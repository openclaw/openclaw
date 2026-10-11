import { expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { runProviderPluginAuthMethodUnpersisted } from "../src/plugins/provider-auth-method.js";
import { createNonExitingRuntime } from "../src/runtime.js";
import { acquireTestPortBlock } from "../src/test-utils/port-claims.js";
import { WizardSession } from "../src/wizard/session.js";

const guardedFetch = vi.hoisted(() => vi.fn());
const loopback = vi.hoisted<{ port: number; boundPorts: number[] }>(() => ({
  port: 0,
  boundPorts: [],
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    startProviderOAuthLoopbackCallbackServer: async (
      params: Parameters<typeof actual.startProviderOAuthLoopbackCallbackServer>[0],
    ) => {
      const redirectUrl = new URL(params.redirectUrl);
      redirectUrl.port = String(loopback.port);
      const server = await actual.startProviderOAuthLoopbackCallbackServer({
        ...params,
        redirectUrl,
      });
      loopback.boundPorts.push(Number(redirectUrl.port));
      return server;
    },
  };
});

it("releases the SIWC callback port when OAuth expires before the wizard note is acknowledged", async () => {
  const method = buildOpenAIProvider().auth.find((entry) => entry.id === "siwc");
  if (!method) {
    throw new Error("OpenAI did not register its SIWC method");
  }
  // Retain ownership across the close/rebind gap; a leaked listener must still fail.
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  loopback.port = portClaim.port;
  loopback.boundPorts = [];
  const timeout = new AbortController();
  const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
  const start = () =>
    new WizardSession(async (prompter, signal) => {
      await runProviderPluginAuthMethodUnpersisted({
        config: {},
        runtime: createNonExitingRuntime(),
        method,
        prompter,
        signal,
        existingProfiles: [],
        isRemote: false,
      });
    });
  const session = start();
  let retry: WizardSession | undefined;
  try {
    const pending = await session.next();
    expect(pending.step).toMatchObject({
      type: "note",
      externalUrl: expect.stringContaining("/api/accounts/authorize?"),
    });
    expect(timeoutSignal).toHaveBeenCalledWith(5 * 60_000);
    // Expire OAuth while the longer-lived wizard still awaits acknowledgement.
    timeout.abort(new DOMException("Sign-in timed out", "TimeoutError"));
    // Retry only after the expired runner has released its callback listener.
    await session.whenSettled();
    expect(await session.next()).toMatchObject({
      done: true,
      status: "error",
      error: "Login cancelled",
    });

    retry = start();
    // SIWC publishes this note only after its callback listener has bound successfully.
    const retried = await retry.next();
    expect(retried, retry.getError()).toMatchObject({
      done: false,
      step: {
        type: "note",
        externalUrl: expect.stringContaining("/api/accounts/authorize?"),
      },
    });
    expect(loopback.port).toBeGreaterThan(0);
    expect(loopback.boundPorts).toEqual([loopback.port, loopback.port]);
    expect(guardedFetch).not.toHaveBeenCalled();
  } finally {
    session.cancel();
    retry?.cancel();
    await Promise.all([session.whenSettled(), retry?.whenSettled()]);
    timeoutSignal.mockRestore();
    await portClaim.release();
  }
});
