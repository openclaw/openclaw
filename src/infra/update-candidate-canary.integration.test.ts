import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  prepareUpdateCandidateRehearsal,
  type UpdateCandidateRehearsal,
} from "./update-candidate-rehearsal.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

it(
  "boots the built candidate with a published updater's occupied sandbox port, then reaps it",
  { timeout: 330_000 },
  async () => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "canary-boundary-")),
    );
    const spawned = vi.mocked(childProcess.spawn);
    spawned.mockClear();
    const occupied = createServer();
    let rehearsal: UpdateCandidateRehearsal | undefined;
    try {
      occupied.listen(0, "127.0.0.1");
      await once(occupied, "listening");
      const address = occupied.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an occupied TCP listener");
      }
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        mcp: { apps: { enabled: true, sandboxPort: address.port } },
      };
      rehearsal = await prepareUpdateCandidateRehearsal({
        candidateRoot: process.cwd(),
        stateDir,
        config,
        env: { PATH: process.env.PATH },
      });
      // Published updaters retain this setting and only supply --update-canary.
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      await fs.writeFile(rehearsal.configPath, JSON.stringify({ ...copied, mcp: config.mcp }));
      const result = await validateUpdateCandidateCanary({
        root: process.cwd(),
        stateDir,
        config,
        rehearsal,
        env: { PATH: process.env.PATH },
        timeoutMs: 300_000,
      });
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      const phases = result.logTail.filter((line) => /^(startupz|readyz):/u.test(line));
      expect(phases).toHaveLength(2);
      expect(phases[0]).toContain("startupz: started");
      expect(phases[1]).toContain("readyz: ready");
      expect(occupied.listening).toBe(true);
      await rehearsal.cleanup();
      expect(await fs.readdir(stateDir)).toEqual([]);
      const callIndex = spawned.mock.calls.findIndex(
        ([, args]) => Array.isArray(args) && args.includes("--update-canary"),
      );
      const gateway = spawned.mock.results[callIndex]?.value as childProcess.ChildProcess;
      expect(gateway.pid).toBeGreaterThan(0);
      expect(() =>
        process.kill(process.platform === "win32" ? gateway.pid! : -gateway.pid!, 0),
      ).toThrow();
      const options = spawned.mock.calls[callIndex]?.[2] as childProcess.SpawnOptions;
      await expect(fs.access(options.env!.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rehearsal?.cleanup();
      if (occupied.listening) {
        await new Promise<void>((resolve, reject) => {
          occupied.close((error) => (error ? reject(error) : resolve()));
        });
      }
      spawned.mockClear();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  },
);
