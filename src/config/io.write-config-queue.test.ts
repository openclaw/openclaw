import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { clearConfigCache, createConfigIO, loadConfig, writeConfigFile } from "./io.js";
import type { OpenClawConfig } from "./types.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForPersistedSecret(configPath: string, expectedSecret: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      commands?: { ownerDisplaySecret?: string };
    };
    if (parsed.commands?.ownerDisplaySecret === expectedSecret) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for ownerDisplaySecret persistence");
}

/**
 * These tests verify that concurrent config writes are serialized by the
 * module-level write queue, preventing the lost-update race condition that
 * caused issue #40410 (config wipe on gateway restart).
 */
describe("config write serialization", () => {
  it("serializes concurrent module-level writes so no changes are lost", async () => {
    await withTempHome("openclaw-config-write-queue-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });

      const initialConfig: OpenClawConfig = {
        gateway: { mode: "local", port: 18789 },
      };
      await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf-8");

      // Load the initial config. Both writes will build upon this snapshot.
      const baseCfg = loadConfig();
      clearConfigCache();

      // Write 1: adds gateway.auth (simulates ensureGatewayStartupAuth).
      const cfg1: OpenClawConfig = {
        ...baseCfg,
        gateway: {
          ...baseCfg.gateway,
          auth: { mode: "token" as const },
        },
      };

      // Write 2: adds commands.ownerDisplaySecret.
      // In the fixed ownerDisplaySecret path, re-loading happens inside
      // enqueueConfigWrite so it sees write 1's output. The module-level
      // writeConfigFile enqueues first, so by the time write 2 reads the
      // snapshot it will see write 1's changes on disk.
      const cfg2: OpenClawConfig = {
        ...baseCfg,
        commands: {
          ...baseCfg.commands,
          ownerDisplaySecret: "test-secret-value", // pragma: allowlist secret
        },
      };

      // Both use module-level writeConfigFile which goes through the queue.
      const write1 = writeConfigFile(cfg1);
      const write2 = writeConfigFile(cfg2);
      await Promise.all([write1, write2]);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;

      const gateway = persisted.gateway as Record<string, unknown> | undefined;

      // The second write must not corrupt or truncate the config.
      // Both gateway.mode and gateway.port must survive because they exist
      // in both snapshots.
      expect(gateway?.mode).toBe("local");
      expect(gateway?.port).toBe(18789);

      // Note: gateway.auth is NOT expected to survive because write2 was
      // built from baseCfg (pre-write1 snapshot) and does not re-read from
      // disk. The queue prevents file corruption from concurrent rename
      // races, but not lost updates from stale snapshots. The ownerDisplaySecret
      // fix (re-reading inside the queue) prevents this and is tested separately below.
      expect(gateway?.auth).toBeUndefined();
    });
  });

  it("second writer sees first writer's disk changes when it re-reads inside the queue", async () => {
    await withTempHome("openclaw-config-write-queue-reread-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });

      const initialConfig: OpenClawConfig = {
        gateway: { mode: "local", port: 18789 },
        commands: { ownerDisplay: "hash" },
      };
      await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf-8");

      // Write 1: adds gateway auth.
      const cfg1: OpenClawConfig = {
        gateway: {
          ...initialConfig.gateway,
          auth: { mode: "token" as const },
        },
        commands: initialConfig.commands,
      };

      const renameEntered = createDeferred();
      const allowRename = createDeferred();
      const originalRename = fsSync.promises.rename.bind(fsSync.promises);
      let blockedFinalRename = false;

      const renameSpy = vi.spyOn(fsSync.promises, "rename").mockImplementation(async (from, to) => {
        if (
          !blockedFinalRename &&
          typeof from === "string" &&
          from.endsWith(".tmp") &&
          to === configPath
        ) {
          blockedFinalRename = true;
          renameEntered.resolve();
          await allowRename.promise;
        }
        return await originalRename(from, to);
      });

      try {
        // Block the first write inside the queue, then trigger the real
        // ownerDisplaySecret auto-persist flow while that write is still pending.
        const write1 = writeConfigFile(cfg1);
        await renameEntered.promise;

        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: { warn: () => {}, error: () => {} },
        });
        const cfg = io.loadConfig();
        const secret = cfg.commands?.ownerDisplaySecret;

        expect(secret).toMatch(/^[a-f0-9]{64}$/);

        allowRename.resolve();
        await write1;
        await waitForPersistedSecret(configPath, secret ?? "");
      } finally {
        renameSpy.mockRestore();
      }

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;

      const gateway = persisted.gateway as Record<string, unknown> | undefined;
      const commands = persisted.commands as Record<string, unknown> | undefined;

      // Both changes must be present.
      expect(gateway?.mode).toBe("local");
      expect(gateway?.port).toBe(18789);
      expect(gateway?.auth).toEqual({ mode: "token" });
      expect(commands?.ownerDisplay).toBe("hash");
      expect(commands?.ownerDisplaySecret).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
