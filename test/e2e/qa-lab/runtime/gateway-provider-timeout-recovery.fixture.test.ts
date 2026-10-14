import { request, type ClientRequest } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("vitest");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:timers/promises");
  vi.doUnmock("../../../../extensions/qa-lab/api.js");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("keeps bootstrap outside the hold deadline and reports progress with console output suppressed", async ({
  signal,
}) => {
  let now = 0;
  let providerUrl = "";
  let providerRequest: ClientRequest | undefined;
  let providerReply: Promise<string> | undefined;
  let requestAt = 0;
  let releasedAt = 0;
  let assistantMessages: unknown[] = [];
  const bootstrap: Array<() => Promise<void>> = [];
  const cleanup: Array<() => Promise<void>> = [];
  const cases: Array<{
    run: (context: { signal: AbortSignal }) => Promise<void>;
    timeout: number;
  }> = [];
  const progress: Array<{ at: number; text: string }> = [];
  const stopped: string[] = [];

  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("OPENCLAW_PROVIDER_TIMEOUT_RECOVERY_PROOF", "1");
  vi.doMock("vitest", () => ({
    expect,
    describe: { runIf: (enabled: boolean) => (_name: string, run: () => void) => enabled && run() },
    beforeAll: (run: () => Promise<void>) => bootstrap.push(run),
    afterAll: (run: () => Promise<void>) => cleanup.push(run),
    afterEach: (run: () => Promise<void>) => cleanup.push(run),
    it: (
      _name: string,
      options: { timeout: number },
      run: (context: { signal: AbortSignal }) => Promise<void>,
    ) => cases.push({ run, timeout: options.timeout }),
  }));
  vi.doMock("node:fs", async (original) => ({
    ...(await original<typeof import("node:fs")>()),
    writeSync: (fd: number, text: string) => {
      expect(fd).toBe(2);
      progress.push({ at: now, text });
      return Buffer.byteLength(text);
    },
  }));
  vi.doMock("node:timers/promises", async (original) => ({
    ...(await original<typeof import("node:timers/promises")>()),
    setTimeout: async (delay: number) => {
      signal.throwIfAborted();
      now += delay;
      // Let the real loopback request advance without spending wall time on the hold.
      await setImmediate();
    },
  }));
  vi.doMock("../../../../extensions/qa-lab/api.js", () => ({
    createQaGatewayChild: () => ({
      start: async (options: { providerBaseUrl: string }) => {
        now += 120_000;
        providerUrl = options.providerBaseUrl;
        return {
          call: async (method: string) => {
            if (method === "diagnostics.stability") {
              return { lastSeq: 1, events: [] };
            }
            if (method === "chat.send") {
              requestAt = now;
              providerReply = new Promise<string>((resolve, reject) => {
                providerRequest = request(
                  `${providerUrl}/responses`,
                  { method: "POST" },
                  (response) => {
                    releasedAt = now;
                    let body = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => {
                      body += chunk;
                    });
                    response.on("end", () => resolve(body));
                    response.on("error", reject);
                  },
                );
                providerRequest.on("error", reject);
                providerRequest.end("{}");
              });
              return { status: "started", runId: "fixture-run" };
            }
            if (method === "agent.wait") {
              const body = await providerReply;
              const completed = body
                ?.split("\n")
                .find((line) => line.includes('"type":"response.completed"'));
              assistantMessages = JSON.parse(completed!.slice("data: ".length)).response.output;
              now += 15_000;
              return { status: "ok" };
            }
            if (method === "chat.history") {
              return { messages: assistantMessages };
            }
            throw new Error(`unexpected fixture RPC: ${method}`);
          },
        };
      },
      stop: async () => {
        now += 60_000;
        stopped.push("gateway");
        return { errors: [] };
      },
    }),
  }));

  try {
    await import("./gateway-provider-timeout-recovery.product-proof.e2e.test.js");
    for (const run of bootstrap) {
      await run();
    }
    expect(cases).toHaveLength(1);
    const test = cases[0]!;
    const bodyStartedAt = now;
    await test.run({ signal });
    const bodyMs = now - bodyStartedAt;
    for (const run of cleanup.splice(0).toReversed()) {
      await run();
    }

    expect.soft(test.timeout).toBe(510_000);
    expect.soft(bodyMs).toBeLessThan(test.timeout);
    expect.soft(releasedAt - requestAt).toBeGreaterThanOrEqual(405_000);
    expect.soft(releasedAt - requestAt).toBeLessThan(450_000);
    expect.soft(stopped).toEqual(["gateway"]);
    expect.soft(now - bodyStartedAt - bodyMs).toBe(60_000);
    const activeProgress = progress.filter(({ text }) =>
      text.includes('"phase":"provider-request-active"'),
    );
    expect.soft(activeProgress.length).toBeGreaterThanOrEqual(7);
    for (const [index, entry] of activeProgress.entries()) {
      expect(entry.at - (activeProgress[index - 1]?.at ?? requestAt)).toBeLessThanOrEqual(60_000);
    }
    expect
      .soft(
        progress.some(({ text }) =>
          text.includes('"phase":"provider-timeout-recovery-proof-complete"'),
        ),
      )
      .toBe(true);
  } finally {
    providerRequest?.destroy();
    for (const run of cleanup.splice(0).toReversed()) {
      await run();
    }
    await providerReply?.catch(() => {});
  }
});
