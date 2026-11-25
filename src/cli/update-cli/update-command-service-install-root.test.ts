import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "./update-command-service-plan.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
// The fixture is a systemd-style command; Windows inspection requires a managed task source.
const itOnPosix = it.skipIf(process.platform === "win32");
let home: string;

beforeEach(() => {
  // Service policy applies only to the account's canonical profile; give the fixture one.
  home = dirs.make("update-service-install-root-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
  vi.stubEnv("OPENCLAW_HOME", undefined);
  mockSystemAccountHome();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function writeInstall(root: string, version: string) {
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "export {};\n");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
}

function stoppedService(root: string): GatewayServiceState {
  return {
    installed: true,
    running: false,
    loadState: { status: "loaded" },
    env: { HOME: home },
    // `openclaw gateway install` writes the entry's real path into the unit.
    command: {
      programArguments: [process.execPath, path.join(root, "dist", "index.js"), "gateway"],
    },
    definitionMutationCapability: { kind: "writable" },
    runtime: { status: "stopped", systemd: { managerUid: 1000 } },
  };
}

/**
 * pnpm 12's global virtual store: the global entry `openclaw` resolves into a
 * versioned store directory, and an update points the entry at a new one.
 */
async function pnpmStoreLayout() {
  const store = path.join(home, "pnpm-home", "store", "v11", "links", "@", "openclaw");
  const previous = path.join(store, "2026.11.4", "hash-a", "node_modules", "openclaw");
  const next = path.join(store, "2026.11.5", "hash-b", "node_modules", "openclaw");
  const entry = path.join(home, "pnpm-home", "global", "v11", "group", "node_modules", "openclaw");
  await writeInstall(previous, "2026.11.4");
  await writeInstall(next, "2026.11.5");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.symlink(previous, entry);
  const state = stoppedService(await fs.realpath(previous));
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({ root: entry, state });
  const before = { serviceEnv: state.env, serviceManagerUid: 1000, serviceUpdateVerdict: verdict };
  const swap = async () => {
    await fs.unlink(entry);
    await fs.symlink(next, entry);
  };
  return { previous, next, entry, state, verdict, before, swap };
}

itOnPosix.each([
  ["old store kept", "restarts"],
  ["old store pruned", "restarts"],
  ["another installation", "refuses"],
  ["an edited definition", "refuses"],
] as const)(
  "after a pnpm package update (%s) revalidation %s the stopped service",
  async (change, outcome) => {
    const layout = await pnpmStoreLayout();
    expect(layout.verdict).toMatchObject({ kind: "owned", refreshDefinition: true });
    await layout.swap();
    const state = stoppedService(await fs.realpath(layout.previous));
    if (change === "old store pruned") {
      await fs.rm(path.dirname(path.dirname(layout.previous)), { recursive: true });
    } else if (change === "another installation") {
      const elsewhere = path.join(home, "elsewhere", "openclaw");
      await writeInstall(elsewhere, "2026.11.5");
      state.command = stoppedService(elsewhere).command;
    } else if (change === "an edited definition") {
      state.command?.programArguments.push("--verbose");
    }

    // The restart names the updated install root; the unit still names the old store path.
    const revalidated = revalidateManagedGatewayServiceAfterUpdate({
      state,
      root: layout.entry,
      preManagedServiceStop: layout.before,
      allowInstallRootChange: true,
    });
    await (outcome === "restarts"
      ? expect(revalidated).resolves.toMatchObject({
          kind: "owned",
          requiresInstallRootRefresh: true,
        })
      : expect(revalidated).rejects.toThrow(
          "Gateway service ownership or manager identity changed",
        ));
  },
);
