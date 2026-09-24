import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatUpdateOneLiner, resolveUpdateAvailability } from "../commands/status.update.js";
import * as processExec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { checkUpdateStatus } from "./update-check.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["owned", "database failure", "timeout", "cancelled"] as const)(
  "reports pacman status for %s without probing npm",
  async (outcome) => {
    const root = path.join(tempDirs.make("openclaw-pacman-status-"), "lib/node_modules/openclaw");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
    const access = fs.access;
    vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (file === "/usr/bin/pacman") {
        return;
      }
      return access(file, mode);
    });
    const controller = new AbortController();
    const reason = new Error("ownership inspection cancelled");
    const commands: string[][] = [];
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => {
      commands.push(argv);
      const pacman = argv[0] === "/usr/bin/pacman";
      if (pacman && outcome === "cancelled") {
        controller.abort(reason);
        throw reason;
      }
      if (pacman && outcome === "timeout") {
        return {
          stdout: "",
          stderr: "",
          code: null,
          signal: "SIGTERM",
          killed: true,
          termination: "timeout",
          timeoutMs: 1000,
        };
      }
      return {
        stdout: pacman && outcome === "owned" ? "openclaw\n" : "",
        stderr: pacman && outcome === "database failure" ? "error: could not open database" : "",
        code: pacman && outcome === "owned" ? 0 : 1,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    await withMockedPlatform("linux", async () => {
      const pending = checkUpdateStatus({
        root,
        includeRegistry: true,
        timeoutMs: 1000,
        signal: controller.signal,
      });
      if (outcome === "cancelled") {
        await expect(pending).rejects.toBe(reason);
        return;
      }
      const status = await pending;
      expect(status).toMatchObject({ installKind: "package", packageManager: "unknown" });
      expect(status.registry).toBeUndefined();
      expect(resolveUpdateAvailability(status).available).toBe(false);
      if (outcome === "owned") {
        expect(status.systemPackage).toMatchObject({ manager: "pacman", packageName: "openclaw" });
        expect(formatUpdateOneLiner(status)).toContain("repository availability not checked");
      } else {
        expect(status.error).toMatchObject({
          status: "failed",
          code: "pacman-ownership-unavailable",
          message: expect.stringContaining("Pacman ownership could not be verified"),
        });
        expect(formatUpdateOneLiner(status)).toContain("update status failed: Pacman ownership");
        expect(status.error?.message).toContain("pacman -Qo");
      }
    });
    expect(
      commands.some(([command]) => command === "npm" || command === "pnpm" || command === "bun"),
    ).toBe(false);
  },
);
