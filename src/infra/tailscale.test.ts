import { readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { captureEnv } from "../test-utils/env.js";
import {
  isTailscaleServeAuthenticationRequiredError,
  TailscaleBackendAuthenticationRequiredError,
  waitForTailscaleBackendReady,
  waitForTailscaleBackendRunning,
} from "./tailscale-backend-ready.js";
import { TailscaleBackendStoppedError } from "./tailscale-backend-stopped-error.js";
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

function useTailscaleSudoFixture(mode: "password" | "conflict" | "authentication") {
  const fixture = fileURLToPath(
    new URL("../../test/fixtures/tailscale-sudo-fixture.mjs", import.meta.url),
  );
  const fakeBin = tempDirs.make("openclaw-tailscale-bin-");
  symlinkSync(fixture, path.join(fakeBin, "sudo"));
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.OPENCLAW_TEST_TAILSCALE_BINARY = fixture;
  process.env.OPENCLAW_TEST_TAILSCALE_SUDO_FIXTURE_MODE = mode;
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
      "OPENCLAW_TEST_TAILSCALE_FIXTURE_COMMAND_LOG",
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
    await expect(getTailnetHostname(exec)).resolves.toBe("100.2.2.2");
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
    await expect(hostPromise).resolves.toBe("retry.tailnet.ts.net");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith(
      tailscaleBin,
      ["status", "--json"],
      expect.objectContaining({ timeoutMs: 5000, logOutput: false }),
    );
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
      await waitForTailscaleBackendReady({
        bin: tailscaleBin,
        managedMode: "serve",
        info,
      });

      expect(exec).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenCalledWith(
        "waiting for the local Tailscale daemon (daemon not reachable)",
      );
    });

    it("hands over to the route claim once the deadline passes", async () => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (now += 45_000));
      const exec = vi.spyOn(processExec, "runExec").mockResolvedValue(status("NoState"));
      const info = vi.fn();
      vi.mocked(sleep).mockResolvedValueOnce(undefined);

      await waitForTailscaleBackendReady({
        bin: tailscaleBin,
        prefix: ["-n", "sudo"],
        managedMode: "funnel",
        info,
      });

      expect(exec.mock.calls.length).toBeGreaterThan(1);
      expect(exec).toHaveBeenNthCalledWith(
        1,
        tailscaleBin,
        ["-n", "sudo", "status", "--json"],
        expect.objectContaining({ timeoutMs: 5000, logOutput: false }),
      );
      expect(info).toHaveBeenCalledTimes(1);
    });

    it.each(["NeedsLogin", "NeedsMachineAuth"] as const)(
      "types the exact %s state for managed Serve without message matching",
      async (BackendState) => {
        const exec = vi.spyOn(processExec, "runExec").mockResolvedValue(status(BackendState));

        await expect(
          waitForTailscaleBackendReady({
            bin: tailscaleBin,
            managedMode: "serve",
            info: vi.fn(),
          }),
        ).rejects.toMatchObject({
          name: "TailscaleBackendAuthenticationRequiredError",
          backendState: BackendState,
          managedMode: "serve",
        });
        expect(exec).toHaveBeenCalledOnce();
      },
    );

    it.each(["NeedsLogin", "NeedsMachineAuth"] as const)(
      "types rejected exit-1 %s status output for managed Serve",
      async (BackendState) => {
        const exec = vi.spyOn(processExec, "runExec").mockRejectedValue(
          Object.assign(new Error("tailscale status exited 1"), {
            exitCode: 1,
            stdout: JSON.stringify({ BackendState }),
            stderr: "",
          }),
        );

        await expect(
          waitForTailscaleBackendReady({
            bin: tailscaleBin,
            managedMode: "serve",
            info: vi.fn(),
          }),
        ).rejects.toMatchObject({
          name: "TailscaleBackendAuthenticationRequiredError",
          backendState: BackendState,
          managedMode: "serve",
        });
        expect(exec).toHaveBeenCalledOnce();
      },
    );

    it("does not classify stopped, unknown, or Funnel login states as Serve prerequisites", async () => {
      const exec = vi.spyOn(processExec, "runExec");
      for (const BackendState of ["Stopped", "FutureState", "NeedsLogin"] as const) {
        exec.mockResolvedValue(status(BackendState));
        const mode = BackendState === "NeedsLogin" ? "funnel" : "serve";
        const error = await waitForTailscaleBackendReady({
          bin: tailscaleBin,
          managedMode: mode,
          info: vi.fn(),
        }).catch((value: unknown) => value);
        expect(isTailscaleServeAuthenticationRequiredError(error)).toBe(false);
        if (BackendState === "Stopped") {
          expect(error).toBeInstanceOf(TailscaleBackendStoppedError);
        } else if (BackendState !== "NeedsLogin") {
          expect(error).toBeUndefined();
        } else {
          expect(error).toBeInstanceOf(TailscaleBackendAuthenticationRequiredError);
        }
      }
    });
  });

  describe("waitForTailscaleBackendRunning", () => {
    const status = (BackendState: string) => ({
      stdout: JSON.stringify({ BackendState }),
      stderr: "",
    });

    it("waits through human-action states and admits only once Tailscale reports Running", async () => {
      vi.useFakeTimers();
      const signal = new AbortController().signal;
      const exec = vi
        .spyOn(processExec, "runExec")
        .mockRejectedValueOnce(
          Object.assign(new Error("tailscale status exited 1"), {
            exitCode: 1,
            stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
            stderr: "",
          }),
        )
        .mockResolvedValueOnce(status("Running"));
      const info = vi.fn();
      try {
        const recovery = waitForTailscaleBackendRunning({
          bin: tailscaleBin,
          info,
          signal,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(recovery).resolves.toBe(true);
        expect(exec).toHaveBeenCalledTimes(2);
        expect(info).toHaveBeenCalledWith(
          "waiting for Tailscale operator action or backend recovery (NeedsLogin)",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not automatically resume a Serve startup when Tailscale is deliberately stopped", async () => {
      const exec = vi.spyOn(processExec, "runExec").mockResolvedValue(status("Stopped"));
      const info = vi.fn();
      await expect(
        waitForTailscaleBackendRunning({
          bin: tailscaleBin,
          info,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(false);
      expect(exec).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith(
        "Tailscale is stopped; automatic Gateway startup recovery is not enabled for this state",
      );
    });

    it("fails closed when a successful status response omits BackendState", async () => {
      const exec = vi
        .spyOn(processExec, "runExec")
        .mockResolvedValue({ stdout: JSON.stringify({ Self: {} }), stderr: "" });
      await expect(
        waitForTailscaleBackendRunning({
          bin: tailscaleBin,
          info: vi.fn(),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Tailscale status did not include a backend state");
      expect(exec).toHaveBeenCalledOnce();
    });

    it.each([
      {
        name: "malformed JSON",
        error: Object.assign(new Error("status output was malformed"), {
          exitCode: 1,
          stdout: "{ BackendState: NeedsLogin",
        }),
      },
      {
        name: "permission denial",
        error: Object.assign(new Error("permission denied"), {
          exitCode: 1,
          stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
          stderr: "permission denied",
        }),
      },
    ])("preserves rejected status errors with $name", async ({ error }) => {
      const exec = vi.spyOn(processExec, "runExec").mockRejectedValue(error);
      await expect(
        waitForTailscaleBackendRunning({
          bin: tailscaleBin,
          info: vi.fn(),
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(error);
      expect(exec).toHaveBeenCalledOnce();
    });

    it("does not classify timed-out status output as an authentication state", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const timeout = Object.assign(new Error("status command timed out"), {
        exitCode: 1,
        stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
        timedOut: true,
      });
      const abort = new DOMException("test stopped wait", "AbortError");
      const exec = vi
        .spyOn(processExec, "runExec")
        .mockRejectedValueOnce(timeout)
        .mockRejectedValueOnce(abort);
      const info = vi.fn();
      const waiting = waitForTailscaleBackendRunning({
        bin: tailscaleBin,
        info,
        signal: controller.signal,
      });
      const rejected = expect(waiting).rejects.toBe(abort);
      try {
        await vi.advanceTimersByTimeAsync(1_000);
        await rejected;
        expect(info).toHaveBeenCalledWith(
          "waiting for Tailscale operator action or backend recovery (daemon not reachable)",
        );
        expect(exec).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves the sudo status command while parking managed Serve recovery",
    async () => {
      useTailscaleSudoFixture("authentication");
      const fixture = process.env.OPENCLAW_TEST_TAILSCALE_BINARY;
      if (!fixture) {
        throw new Error("expected synthetic Tailscale binary");
      }
      const tempDir = tempDirs.make("openclaw-tailscale-auth-recovery-");
      const commandLog = path.join(tempDir, "commands.jsonl");
      const pollMarker = path.join(tempDir, "recovery-poll");
      process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_COMMAND_LOG = commandLog;
      process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER = pollMarker;

      const error = await claimTailscaleRoute("serve", 18791, 18791, vi.fn()).catch(
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(TailscaleBackendAuthenticationRequiredError);
      expect(error).toMatchObject({
        backendState: "NeedsLogin",
        statusCommand: { bin: "sudo", prefix: ["-n", fixture] },
      });
      if (!(error instanceof TailscaleBackendAuthenticationRequiredError)) {
        throw new Error("expected typed Tailscale authentication prerequisite");
      }

      const controller = new AbortController();
      const waiting = waitForTailscaleBackendRunning({
        bin: error.statusCommand.bin,
        prefix: [...error.statusCommand.prefix],
        signal: controller.signal,
        info: vi.fn(),
      });
      try {
        await waitForFixtureFile(pollMarker, waiting, "recovery-poll");
      } finally {
        controller.abort();
      }
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });

      const commands = readFileSync(commandLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[] });
      expect(commands.map(({ args }) => args)).toEqual([
        ["status", "--json"],
        ["serve", "status", "--json"],
        ["-n", fixture, "status", "--json"],
        ["-n", fixture, "status", "--json"],
      ]);
    },
  );

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
