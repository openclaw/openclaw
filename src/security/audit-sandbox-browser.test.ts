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
  it.each([
    {
      name: "missing and stale hash labels",
      labels: { old: "abc123\tepoch-v0\n", missing: "<no value>\t<no value>\n" },
      ports: "",
      expected: [
        finding("hash_label_missing"),
        expect.objectContaining({
          checkId: "sandbox.browser_container.hash_epoch_stale",
          severity: "warn",
          detail: expect.stringContaining("openclaw-sbx-browser-old"),
        }),
      ],
    },
    {
      name: "non-loopback published ports",
      labels: { exposed: "hash123\t2026-02-21-novnc-auth-default\n" },
      ports: "6080/tcp -> 0.0.0.0:49101\n9222/tcp -> 127.0.0.1:49100\n",
      expected: [finding("non_loopback_publish", "critical")],
    },
  ])("warns about $name", async ({ labels, ports, expected }) => {
    const containers = new Map(
      Object.entries(labels).map(([name, label]) => [`openclaw-sbx-browser-${name}`, label]),
    );
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async (args) => {
        if (args[0] === "ps") {
          return dockerResult([...containers.keys()].join("\n") + "\n");
        }
        const label = containers.get(args.at(-1) ?? "");
        if (args[0] === "inspect" && label) {
          return dockerResult(label);
        }
        if (args[0] === "port" && ports && containers.has(args.at(-1) ?? "")) {
          return dockerResult(ports);
        }
        return dockerResult("", "not found", 1);
      },
    });
    for (const expectedFinding of expected) {
      expect(findings).toContainEqual(expectedFinding);
    }
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

  it.each(["ps", "inspect"])(
    "bounds hung Docker %s probes and stops remaining work",
    async (hangAt) => {
      const calls: string[] = [];
      let probeSignal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      vi.useFakeTimers();
      const pending = collectSandboxBrowserHashLabelFindings({
        timeoutMs: 250,
        execDockerRawFn: async (args, opts) => {
          calls.push(`${args[0] ?? ""}:${args.at(-1) ?? ""}`);
          if (args[0] === "ps" && hangAt === "inspect") {
            return dockerResult("openclaw-sbx-browser-hung\nopenclaw-sbx-browser-next\n");
          }
          probeSignal = opts?.signal;
          markStarted();
          return await new Promise((_, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      });
      await started;
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toEqual([finding("docker_probe_timeout")]);
      expect(probeSignal?.aborted).toBe(true);
      expect(calls).toEqual(
        hangAt === "ps"
          ? ["ps:{{.Names}}"]
          : ["ps:{{.Names}}", "inspect:openclaw-sbx-browser-hung"],
      );
    },
  );
});
