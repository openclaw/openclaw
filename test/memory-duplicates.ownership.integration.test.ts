import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerMemoryCli } from "../extensions/memory-core/runtime-api.js";
import { resetConfigRuntimeState } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.js";
import * as secretResolution from "../src/gateway/resolve-configured-secret-input-string.js";
import { resolveNodeRuntimeExecutable } from "../src/infra/node-runtime-executable.js";
import { defaultRuntime } from "../src/runtime.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetConfigRuntimeState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function holdExternalOwner(): Promise<() => Promise<void>> {
  const child = spawn(
    resolveNodeRuntimeExecutable() ?? process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "-e",
      `const { acquireGatewayLock } = await import('./src/infra/gateway-lock.ts');
       const lock = await acquireGatewayLock({ allowInTests: true, role: 'agent-embedded', databaseAccess: 'none' });
       if (!lock) throw new Error('Synthetic owner was not acquired');
       process.on('message', async () => { await lock.release(); process.exit(0); });
       process.send('ready');`,
    ],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(child, "exit");
  try {
    const [message] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(20_000) }),
      exited.then(() => {
        throw new Error("Synthetic owner exited before becoming ready");
      }),
    ]);
    expect(message).toBe("ready");
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  return async () => {
    child.send("stop");
    expect((await exited)[0]).toBe(0);
  };
}

it.each([
  { source: "env", owned: false },
  { source: "file", owned: false },
  { source: "exec", owned: false },
  { source: "env", owned: true },
] as const)(
  "admits registered file-only diagnostics without a PostgreSQL $source SecretRef (owned: $owned)",
  async ({ source, owned }) => {
    const root = roots.make("openclaw-duplicates-postgres-ref-");
    const workspace = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    const text = "Synthetic policy: refunds within thirty days, except custom-made products.\n";
    const original = path.join(workspace, "memory/policy.md");
    await fs.writeFile(original, text);
    await fs.writeFile(path.join(workspace, "memory/copy.md"), text);
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace } } },
      memory: { search: { provider: "none" } },
      database: {
        engine: "postgres",
        postgres: {
          connection: {
            source,
            provider: source === "env" ? "default" : "synthetic-unavailable",
            id:
              source === "env"
                ? "SYNTHETIC_UNSET_POSTGRES_DSN"
                : source === "file"
                  ? "/dsn"
                  : "synthetic/dsn",
          },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("SYNTHETIC_UNSET_POSTGRES_DSN", "");
    // mock-isolation: A trap forbids all secret I/O; CLI, configuration and offline lease stay real.
    const resolve = vi
      .spyOn(secretResolution, "resolveCanonicalConfiguredSecretInputString")
      .mockRejectedValue(new Error("Synthetic unrelated secret resolver must not run"));
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn");
    const release = owned ? await holdExternalOwner() : undefined;
    const cli = new Command().exitOverride();
    registerMemoryCli(cli);
    try {
      const run = cli.parseAsync(["memory", "duplicates", "--json", "--min-chars", "1"], {
        from: "user",
      });
      if (owned) {
        await expect(run).rejects.toMatchObject({ code: "OWNER_UNAVAILABLE" });
        expect(json).not.toHaveBeenCalled();
      } else {
        await run;
        expect(json).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            filesScanned: 2,
            duplicateGroupCount: 1,
            duplicateOccurrenceCount: 2,
          }),
        );
      }
    } finally {
      await release?.();
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(await fs.readFile(original, "utf8")).toBe(text);
    await expect(fs.stat(path.join(root, "state/openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
