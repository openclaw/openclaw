import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSandboxBrowserHashLabelFindings } from "./audit-extra.async.js";

function dockerResult(stdout = "", stderr = "", code = 0) {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), code };
}

function finding(suffix: string, severity = "warn") {
  return expect.objectContaining({ checkId: `sandbox.browser_container.${suffix}`, severity });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("security audit sandbox browser findings", () => {
  it("warns when sandbox browser containers have missing or stale hash labels", async () => {
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async (args: string[]) => {
        if (args[0] === "ps") {
          return dockerResult("openclaw-sbx-browser-old\nopenclaw-sbx-browser-missing-hash\n");
        }
        if (args[0] === "inspect" && args.at(-1) === "openclaw-sbx-browser-old") {
          return dockerResult("abc123\tepoch-v0\n");
        }
        if (args[0] === "inspect" && args.at(-1) === "openclaw-sbx-browser-missing-hash") {
          return dockerResult("<no value>\t<no value>\n");
        }
        return dockerResult("", "not found", 1);
      },
    });

    expect(findings).toContainEqual(finding("hash_label_missing"));
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "sandbox.browser_container.hash_epoch_stale",
        severity: "warn",
        detail: expect.stringContaining("openclaw-sbx-browser-old"),
      }),
    );
  });

  it("skips sandbox browser hash label checks when docker inspect is unavailable", async () => {
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async () => {
        throw new Error("spawn docker ENOENT");
      },
    });
    expect(findings).not.toContainEqual(finding("hash_label_missing"));
    expect(findings).not.toContainEqual(finding("hash_epoch_stale"));
  });

  it("bounds sandbox browser Docker probes that do not return", async () => {
    let probeSignal: AbortSignal | undefined;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });

    vi.useFakeTimers();
    const findingsPromise = collectSandboxBrowserHashLabelFindings({
      timeoutMs: 250,
      execDockerRawFn: async (_args, opts) => {
        probeSignal = opts?.signal;
        markProbeStarted();
        return await new Promise((_, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    await probeStarted;
    await vi.advanceTimersByTimeAsync(250);

    const findings = await findingsPromise;

    expect(probeSignal?.aborted).toBe(true);
    expect(findings).toEqual([finding("docker_probe_timeout")]);
  });

  it("stops probing remaining sandbox browser containers after a Docker timeout", async () => {
    const calls: string[] = [];
    let markHungProbeStarted!: () => void;
    const hungProbeStarted = new Promise<void>((resolve) => {
      markHungProbeStarted = resolve;
    });

    vi.useFakeTimers();
    const findingsPromise = collectSandboxBrowserHashLabelFindings({
      timeoutMs: 250,
      execDockerRawFn: async (args, opts) => {
        calls.push(`${args[0] ?? ""}:${args.at(-1) ?? ""}`);
        if (args[0] === "ps") {
          return dockerResult("openclaw-sbx-browser-hung\nopenclaw-sbx-browser-next\n");
        }
        markHungProbeStarted();
        return await new Promise((_, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    await hungProbeStarted;
    await vi.advanceTimersByTimeAsync(250);

    const findings = await findingsPromise;

    expect(calls).toEqual(["ps:{{.Names}}", "inspect:openclaw-sbx-browser-hung"]);
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "sandbox.browser_container.docker_probe_timeout",
      }),
    ]);
  });

  it("flags sandbox browser containers with non-loopback published ports", async () => {
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async (args: string[]) => {
        if (args[0] === "ps") {
          return dockerResult("openclaw-sbx-browser-exposed\n");
        }
        if (args[0] === "inspect" && args.at(-1) === "openclaw-sbx-browser-exposed") {
          return dockerResult("hash123\t2026-02-21-novnc-auth-default\n");
        }
        if (args[0] === "port" && args.at(-1) === "openclaw-sbx-browser-exposed") {
          return dockerResult("6080/tcp -> 0.0.0.0:49101\n9222/tcp -> 127.0.0.1:49100\n");
        }
        return dockerResult("", "not found", 1);
      },
    });

    expect(findings).toContainEqual(finding("non_loopback_publish", "critical"));
  });
});
