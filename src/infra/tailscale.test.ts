import { symlinkSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { captureEnv } from "../test-utils/env.js";
import { waitForTailscaleBackendReady } from "./tailscale-backend-ready.js";
import {
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  readTailscaleWhoisIdentity as readWhois,
  claimTailscaleRoute,
  hasTailscaleFunnelRouteForPort,
} from "./tailscale.js";

vi.mock("node:timers/promises", { spy: true });
const tailscaleBin = "tailscale";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function useTailscaleSudoFixture(mode: "password" | "conflict") {
  const fixture = fileURLToPath(
    new URL("../../test/fixtures/tailscale-sudo-fixture.mjs", import.meta.url),
  );
  const fakeBin = tempDirs.make("openclaw-tailscale-bin-");
  symlinkSync(fixture, path.join(fakeBin, "sudo"));
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.OPENCLAW_TEST_TAILSCALE_BINARY = fixture;
  process.env.OPENCLAW_TEST_TAILSCALE_SUDO_FIXTURE_MODE = mode;
}

function expectExecCall(
  exec: ReturnType<typeof vi.fn>,
  callNumber: number,
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) {
  expect(exec).toHaveBeenNthCalledWith(
    callNumber,
    command,
    args,
    ...(options ? [expect.objectContaining(options)] : []),
  );
}

const jsonReply = (value: unknown) => ({ stdout: JSON.stringify(value) });
const whois = (LoginName: string) => jsonReply({ UserProfile: { LoginName } });

describe("tailscale helpers", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_TEST_TAILSCALE_BINARY",
      "OPENCLAW_TEST_TAILSCALE_SUDO_FIXTURE_MODE",
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER",
      "NODE_ENV",
      "PATH",
      "VITEST",
    ]);
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY = "tailscale";
    process.env.VITEST ??= "true";
  });

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("falls back to IP when DNS missing", async () => {
    const exec = vi.fn().mockResolvedValue(jsonReply({ Self: { TailscaleIPs: ["100.2.2.2"] } }));
    const host = await getTailnetHostname(exec);
    expect(host).toBe("100.2.2.2");
  });

  it.each([
    ["ordinary", getTailnetHostname],
    ["post-Serve", getTailnetHostnameAfterServe],
  ] as const)("reads the hostname from a large %s status response", async (_name, lookup) => {
    const exec: typeof processExec.runExec = (_command, _args, options) =>
      processExec.runExec(
        process.execPath,
        [
          "-e",
          `console.log("warning: stale state"); console.log(JSON.stringify({
            Self: { DNSName: "large.tailnet.ts.net." },
            Peer: Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [
              "peer" + i, { DNSName: "peer-" + i + ".tailnet.ts.net.", Online: true }
            ]))
          }))`,
        ],
        options,
      );

    await expect(lookup(exec)).resolves.toBe("large.tailnet.ts.net");
  });

  it("retries post-Serve status after a transient failure", async () => {
    vi.useFakeTimers();
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed to connect to local tailscaled"))
      .mockResolvedValueOnce(
        jsonReply({ Self: { DNSName: "retry.tailnet.ts.net.", TailscaleIPs: ["100.7.7.7"] } }),
      );

    const hostPromise = getTailnetHostnameAfterServe(exec);
    await vi.runAllTimersAsync();
    const host = await hostPromise;

    expect(host).toBe("retry.tailnet.ts.net");
    expect(exec).toHaveBeenCalledTimes(2);
    expectExecCall(exec, 1, tailscaleBin, ["status", "--json"], {
      timeoutMs: 5000,
      logOutput: false,
    });
    expectExecCall(exec, 2, tailscaleBin, ["status", "--json"], {
      timeoutMs: 5000,
      logOutput: false,
    });
  });

  it("does not retry malformed post-Serve status JSON", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "{not json}" });

    await expect(getTailnetHostnameAfterServe(exec)).rejects.toThrow(SyntaxError);

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary hostname lookup single-attempt", async () => {
    const failure = new Error("Failed to connect to local Tailscale daemon; not running?");
    const exec = vi.fn().mockRejectedValue(failure);

    await expect(getTailnetHostname(exec, tailscaleBin)).rejects.toThrow(failure.message);

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("caches malformed tailscale whois output on the short error TTL path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "warning: stale state\n{not json}\n" })
      .mockResolvedValueOnce({
        stdout:
          'warning: stale state\n{"UserProfile":{"LoginName":"after@example.com","DisplayName":"Operator"}}\n',
      });

    const lookup = () => readWhois("100.64.0.12", exec, { errorTtlMs: 1_000 });
    await expect(lookup()).resolves.toBeNull();
    await expect(lookup()).resolves.toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);

    await expect(lookup()).resolves.toEqual({
      login: "after@example.com",
      name: "Operator",
    });

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("bypasses existing whois results when the cache TTL is zero", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(whois("before@example.com"))
      .mockRejectedValueOnce(new Error("no longer authorized"));

    await expect(readWhois("100.64.0.13", exec)).resolves.toEqual({
      login: "before@example.com",
    });
    await expect(
      readWhois("100.64.0.13", exec, { cacheTtlMs: 0, errorTtlMs: 0 }),
    ).resolves.toBeNull();

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not cache whois results when the cache expiry would exceed Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const exec = vi
      .fn()
      .mockResolvedValueOnce(whois("first@example.com"))
      .mockResolvedValueOnce(whois("second@example.com"));

    await expect(readWhois("100.64.0.10", exec)).resolves.toEqual({
      login: "first@example.com",
    });
    await expect(readWhois("100.64.0.10", exec)).resolves.toEqual({
      login: "second@example.com",
    });

    expect(exec).toHaveBeenCalledTimes(2);
  });

  describe("waitForTailscaleBackendReady", () => {
    const status = (BackendState: string) => ({ ...jsonReply({ BackendState }), stderr: "" });
    const statusArgs = ["status", "--json"];
    const execOptions = { timeoutMs: 5000, logOutput: false };

    // Connect-failure wording as emitted by the tailscale CLI (cmd/tailscale/cli/diag.go),
    // which differs by platform and by whether a tailscaled process was found.
    it("waits while the daemon is not accepting connections yet", async () => {
      const stderr =
        "failed to connect to local tailscaled process; is the Tailscale service running?";
      const exec = vi
        .spyOn(processExec, "runExec")
        .mockRejectedValueOnce(Object.assign(new Error("status failed"), { stderr }))
        .mockResolvedValueOnce(status("Running"));
      const info = vi.fn();

      vi.mocked(sleep).mockResolvedValueOnce(undefined);
      await waitForTailscaleBackendReady({ bin: tailscaleBin, info });

      expect(exec).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenCalledWith(
        "waiting for the local Tailscale daemon (daemon not reachable)",
      );
    });

    it("hands over to the route claim once the deadline passes", async () => {
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => (now += 45_000));
      const exec = vi.spyOn(processExec, "runExec").mockResolvedValue(status("NoState"));
      const info = vi.fn();
      vi.mocked(sleep).mockResolvedValueOnce(undefined);

      await waitForTailscaleBackendReady({
        bin: tailscaleBin,
        prefix: ["-n", "sudo"],
        info,
      });

      expect(exec.mock.calls.length).toBeGreaterThan(1);
      expectExecCall(exec, 1, tailscaleBin, ["-n", "sudo", ...statusArgs], execOptions);
      expect(info).toHaveBeenCalledTimes(1);
    });
  });

  describe.runIf(process.platform !== "win32")("sudo fallback diagnostics", () => {
    it.each([
      [
        "password",
        18791,
        /sudo: a password is required[\s\S]*sudo tailscale set --operator=\$USER/,
      ],
      ["conflict", 18789, "ownership OpenClaw cannot prove; it was not modified"],
    ] as const)("preserves %s diagnostics", async (mode, port, diagnostic) => {
      useTailscaleSudoFixture(mode);
      await expect(claimTailscaleRoute("serve", port, port, vi.fn())).rejects.toThrow(diagnostic);
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves route diagnostics when startup readiness times out",
    async () => {
      const fixture = fileURLToPath(
        new URL("../../test/fixtures/tailscale-foreground-fixture.mjs", import.meta.url),
      );
      const marker = path.join(tempDirs.make("openclaw-tailscale-fixture-"), "ready");
      process.env.OPENCLAW_TEST_TAILSCALE_BINARY = fixture;
      process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER = marker;
      const schedule = globalThis.setTimeout;
      let fireDeadline: (() => void) | undefined;
      let fires = 0;
      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, ms, ...args) => {
          const timer = schedule(callback, ms, ...args);
          if (ms === 15_000) {
            timerSpy.mockRestore();
            fireDeadline = () => {
              expect(timer.hasRef()).toBe(false);
              expect(fires).toBe(0);
              clearTimeout(timer);
              fires += 1;
              callback(...args);
            };
          }
          return timer;
        });
      const claim = claimTailscaleRoute("funnel", 18790, 18790, vi.fn());
      let settled = false;
      const markSettled = () => {
        settled = true;
      };
      const completion = claim.then(markSettled, markSettled);
      try {
        await waitForFixtureFile(marker, completion, "ready");
        expect(settled).toBe(false);
        if (!fireDeadline) {
          throw new Error("expected the native 15000ms startup deadline");
        }
        fireDeadline();
        await expect(claim).rejects.toThrow("Funnel is not enabled on your tailnet.");
        expect(fires).toBe(1);
      } finally {
        // Leave the native deadline armed if fixture readiness fails; await real worker cleanup.
        await completion;
        timerSpy.mockRestore();
      }
    },
  );

  it.each([
    ["https+insecure://localhost:18789", true, true],
    ["18789", true, true],
    ["http://127.0.0.1:9000", true, false],
    ["http://10.0.0.5:18789", true, false],
    ["http://127.0.0.1:18789", false, false],
  ] as const)("validates Funnel proxy %s (allowed: %s)", async (proxy, allowed, expected) => {
    const host = "device.tailnet.ts.net:443";
    vi.spyOn(processExec, "runExec").mockResolvedValue({
      stdout: `warning: stale state\n${JSON.stringify({
        AllowFunnel: { [host]: allowed },
        Web: { [host]: { Handlers: { "/": { Proxy: proxy } } } },
      })}\n`,
      stderr: "",
    });

    await expect(hasTailscaleFunnelRouteForPort(18789)).resolves.toBe(expected);
  });

  it("hasTailscaleFunnelRouteForPort preserves malformed status parse failures", async () => {
    const stdout = "warning: stale state\n{not json}\n";
    vi.spyOn(processExec, "runExec").mockResolvedValue({ stdout, stderr: "" });
    await expect(hasTailscaleFunnelRouteForPort(18789)).rejects.toThrow(SyntaxError);
  });

  it("hasTailscaleFunnelRouteForPort preserves status command failures", async () => {
    const failure = new Error("tailscale status unavailable");
    vi.spyOn(processExec, "runExec").mockRejectedValue(failure);
    await expect(hasTailscaleFunnelRouteForPort(18789)).rejects.toBe(failure);
  });
});
