import { expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { runProviderPluginAuthMethodUnpersisted } from "../src/plugins/provider-auth-method.js";
import { createNonExitingRuntime } from "../src/runtime.js";
import { WizardSession } from "../src/wizard/session.js";

const guardedFetch = vi.hoisted(() => vi.fn());
const loopback = vi.hoisted<{ port: number; boundPorts: number[] }>(() => ({
  port: 0,
  boundPorts: [],
}));
const observation = vi.hoisted(() => ({
  events: [] as string[],
  disposers: [] as Array<() => void>,
  nextServer: 0,
  nextWizard: 0,
  record(event: string) {
    if (this.events.length < 32) {
      this.events.push(event);
    }
  },
  errorClass(error: unknown): string {
    const message = error instanceof Error ? error.message : error;
    if (message === undefined) {
      return "absent";
    }
    if (message === "Login cancelled" || message === "Sign-in timed out") {
      return message;
    }
    // Node's listen errors include the bound address and port; retain only a known code.
    const code =
      typeof message === "string"
        ? /^(?:listen|bind|accept) (EADDRINUSE|EACCES|EADDRNOTAVAIL|EINVAL|EMFILE|ENFILE|ENOBUFS|ENOMEM|EBADF):/u.exec(
            message,
          )?.[1]
        : undefined;
    return code ?? "unclassified-redacted";
  },
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  const { errorMonitor } = await import("node:events");
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      const listen = server.listen.bind(server);
      vi.spyOn(server, "listen").mockImplementation((...listenArgs) => {
        if (listenArgs[0] === 8080) {
          // Isolate the test, but reuse its first real port so a leaked listener still fails.
          listenArgs[0] = loopback.port;
          server.once("listening", () => {
            const address = server.address();
            if (address && typeof address !== "string") {
              loopback.port = address.port;
              loopback.boundPorts.push(address.port);
            }
          });
          const id = ++observation.nextServer;
          observation.record(`server:${id}:listen:${loopback.port === 0 ? "ephemeral" : "reuse"}`);
          const onListening = () => observation.record(`server:${id}:listening`);
          const onError = (error: unknown) =>
            observation.record(`server:${id}:error:${observation.errorClass(error)}`);
          const onClose = () => observation.record(`server:${id}:close`);
          server.on("listening", onListening);
          server.on(errorMonitor, onError);
          server.on("close", onClose);
          observation.disposers.push(() => {
            server.off("listening", onListening);
            server.off(errorMonitor, onError);
            server.off("close", onClose);
          });
        }
        return listen(...listenArgs);
      });
      return server;
    },
  };
});

it("releases the SIWC callback port when OAuth expires before the wizard note is acknowledged", async () => {
  const method = buildOpenAIProvider().auth.find((entry) => entry.id === "siwc");
  if (!method) {
    throw new Error("OpenAI did not register its SIWC method");
  }
  const timeout = new AbortController();
  const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
  const onTimeout = () =>
    observation.record(`timeout:abort:${observation.errorClass(timeout.signal.reason)}`);
  timeout.signal.addEventListener("abort", onTimeout, { once: true });
  observation.disposers.push(() => timeout.signal.removeEventListener("abort", onTimeout));
  const start = () =>
    new WizardSession(async (prompter, signal) => {
      const id = ++observation.nextWizard;
      observation.record(`wizard:${id}:start:${signal.aborted ? "aborted" : "active"}`);
      const onAbort = () =>
        observation.record(`wizard:${id}:abort:${observation.errorClass(signal.reason)}`);
      signal.addEventListener("abort", onAbort, { once: true });
      observation.disposers.push(() => signal.removeEventListener("abort", onAbort));
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
    observation.record("wizard:1:settled");
    expect(await session.next()).toMatchObject({
      done: true,
      status: "error",
      error: "Login cancelled",
    });

    retry = start();
    // SIWC publishes this note only after its callback listener has bound successfully.
    const retryStep = await retry.next();
    expect(
      retryStep,
      JSON.stringify({
        retryError: observation.errorClass(retryStep.error),
        events: observation.events,
      }),
    ).toMatchObject({
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
    for (const dispose of observation.disposers.splice(0)) {
      dispose();
    }
  }
});
