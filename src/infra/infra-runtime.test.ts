import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { ensureBinary } from "./binaries.js";
import {
  __testing,
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  scheduleGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
} from "./restart.js";
import { createTelegramRetryRunner } from "./retry-policy.js";
import { getShellPathFromLoginShell, resetShellPathCacheForTests } from "./shell-env.js";
import { listTailnetAddresses } from "./tailnet.js";

describe("infra runtime", () => {
  describe("ensureBinary", () => {
    it("passes through when binary exists", async () => {
      const exec: typeof runExec = vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "",
      });
      const runtime: RuntimeEnv = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      await ensureBinary("node", exec, runtime);
      expect(exec).toHaveBeenCalledWith("which", ["node"]);
    });

    it("logs and exits when missing", async () => {
      const exec: typeof runExec = vi.fn().mockRejectedValue(new Error("missing"));
      const error = vi.fn();
      const exit = vi.fn(() => {
        throw new Error("exit");
      });
      await expect(ensureBinary("ghost", exec, { log: vi.fn(), error, exit })).rejects.toThrow(
        "exit",
      );
      expect(error).toHaveBeenCalledWith("Missing required binary: ghost. Please install it.");
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe("createTelegramRetryRunner", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries when custom shouldRetry matches non-telegram error", async () => {
      vi.useFakeTimers();
      const runner = createTelegramRetryRunner({
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        shouldRetry: (err) => err instanceof Error && err.message === "boom",
      });
      const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");

      const promise = runner(fn, "request");
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("restart authorization", () => {
    beforeEach(() => {
      __testing.resetSigusr1State();
      vi.useFakeTimers();
      vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(async () => {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      vi.restoreAllMocks();
      __testing.resetSigusr1State();
    });

    it("consumes a scheduled authorization once", async () => {
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

      scheduleGatewaySigusr1Restart({ delayMs: 0 });

      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

      await vi.runAllTimersAsync();
    });

    it("tracks external restart policy", () => {
      expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
      setGatewaySigusr1RestartPolicy({ allowExternal: true });
      expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(true);
    });
  });

  describe("getShellPathFromLoginShell", () => {
    afterEach(() => resetShellPathCacheForTests());

    it("returns PATH from login shell env", () => {
      if (process.platform === "win32") {
        return;
      }
      const exec = vi
        .fn()
        .mockReturnValue(Buffer.from("PATH=/custom/bin\0HOME=/home/user\0", "utf-8"));
      const result = getShellPathFromLoginShell({ env: { SHELL: "/bin/sh" }, exec });
      expect(result).toBe("/custom/bin");
    });

    it("caches the value", () => {
      if (process.platform === "win32") {
        return;
      }
      const exec = vi.fn().mockReturnValue(Buffer.from("PATH=/custom/bin\0", "utf-8"));
      const env = { SHELL: "/bin/sh" } as NodeJS.ProcessEnv;
      expect(getShellPathFromLoginShell({ env, exec })).toBe("/custom/bin");
      expect(getShellPathFromLoginShell({ env, exec })).toBe("/custom/bin");
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it("returns null on exec failure", () => {
      if (process.platform === "win32") {
        return;
      }
      const exec = vi.fn(() => {
        throw new Error("boom");
      });
      const result = getShellPathFromLoginShell({ env: { SHELL: "/bin/sh" }, exec });
      expect(result).toBeNull();
    });
  });

  describe("tailnet address detection", () => {
    it("detects tailscale IPv4 and IPv6 addresses", () => {
      vi.spyOn(os, "networkInterfaces").mockReturnValue({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" }],
        utun9: [
          {
            address: "100.123.224.76",
            family: "IPv4",
            internal: false,
            netmask: "",
          },
          {
            address: "fd7a:115c:a1e0::8801:e04c",
            family: "IPv6",
            internal: false,
            netmask: "",
          },
        ],
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any);

      const out = listTailnetAddresses();
      expect(out.ipv4).toEqual(["100.123.224.76"]);
      expect(out.ipv6).toEqual(["fd7a:115c:a1e0::8801:e04c"]);
    });
  });
});
