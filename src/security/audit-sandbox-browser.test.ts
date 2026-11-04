import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSandboxBrowserHashLabelFindings } from "./audit-extra.async.js";

function dockerResult(stdout = "", stderr = "", code = 0) {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), code };
}
function finding(suffix: string, severity = "warn", extra = {}) {
  return expect.objectContaining({
    checkId: `sandbox.browser_container.${suffix}`,
    severity,
    ...extra,
  });
}
afterEach(() => vi.useRealTimers());

describe("security audit sandbox browser findings", () => {
  it("reports missing labels, stale epochs, and exposed ports across browser containers", async () => {
    const labels = new Map([
      ["openclaw-sbx-browser-old", "abc123\tepoch-v0\n"],
      ["openclaw-sbx-browser-missing", "<no value>\t<no value>\n"],
      ["openclaw-sbx-browser-exposed", "hash123\t2026-02-21-novnc-auth-default\n"],
    ]);
    const findings = await collectSandboxBrowserHashLabelFindings({
      execDockerRawFn: async (args) => {
        const name = args.at(-1) ?? "";
        if (args[0] === "ps") {
          return dockerResult([...labels.keys()].join("\n") + "\n");
        }
        if (args[0] === "inspect" && labels.has(name)) {
          return dockerResult(labels.get(name));
        }
        if (args[0] === "port" && labels.has(name)) {
          return dockerResult(
            name.endsWith("-exposed")
              ? "6080/tcp -> 0.0.0.0:49101\n9222/tcp -> 127.0.0.1:49100\n"
              : "",
          );
        }
        return dockerResult("", "not found", 1);
      },
    });
    expect(findings).toContainEqual(finding("hash_label_missing"));
    expect(findings).toContainEqual(
      finding("hash_epoch_stale", "warn", {
        detail: expect.stringContaining("openclaw-sbx-browser-old"),
      }),
    );
    expect(findings).toContainEqual(finding("non_loopback_publish", "critical"));
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
