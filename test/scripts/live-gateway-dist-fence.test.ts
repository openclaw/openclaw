import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  gatewayServiceCommandOverlapsPhysicalCheckout,
  isLiveManagedGatewayHoldingDist,
  resolveLiveManagedGatewayDistFence,
} from "../../scripts/lib/live-gateway-dist-fence.mts";
import type { GatewayServiceState } from "../../src/daemon/service-types.ts";
import { withTestDir } from "../../src/test-helpers/temp-dir.js";

function baseState(overrides: Partial<GatewayServiceState> = {}): GatewayServiceState {
  return {
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    env: {},
    command: {
      programArguments: [
        "/usr/bin/node",
        "/srv/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
      ],
    },
    ...overrides,
  };
}

describe("live-gateway-dist-fence", () => {
  it("allows builds when OPENCLAW_ALLOW_LIVE_DIST_BUILD=1 even if the gateway is live", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      env: { OPENCLAW_ALLOW_LIVE_DIST_BUILD: "1" },
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => true,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("allows builds when the managed Gateway does not use this checkout", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => false,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("allows builds when this checkout matches but the Gateway is stopped", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: false,
          runtime: { status: "stopped", pid: undefined },
        }),
      matchesRoot: async () => true,
      isPidAlive: () => false,
    });
    expect(result).toEqual({ refuse: false });
  });

  it("refuses when this checkout matches and the Gateway is running", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: true,
          runtime: {
            status: "running",
            pid: 4242,
            systemd: { unit: "openclaw-gateway.service" },
          },
        }),
      matchesRoot: async () => true,
    });
    expect(result.refuse).toBe(true);
    if (result.refuse) {
      expect(result.message).toContain("Refusing to rebuild dist");
      expect(result.message).toContain("/srv/openclaw/dist/index.js");
      expect(result.message).toContain("openclaw-gateway.service");
      expect(result.message).toContain("OPENCLAW_ALLOW_LIVE_DIST_BUILD=1");
    }
  });

  it("refuses while a matching Gateway PID is still alive during deactivating drain", async () => {
    expect(
      isLiveManagedGatewayHoldingDist(
        baseState({
          running: false,
          runtime: { status: "deactivating", subState: "stop-sigterm", pid: 99 },
        }),
        { isPidAlive: (pid) => pid === 99 },
      ),
    ).toBe(true);

    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () =>
        baseState({
          running: false,
          runtime: { status: "deactivating", subState: "stop-sigterm", pid: 99 },
        }),
      matchesRoot: async () => true,
      isPidAlive: (pid) => pid === 99,
    });
    expect(result.refuse).toBe(true);
  });

  it("fails open when service inspection throws", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => {
        throw new Error("no systemd");
      },
    });
    expect(result).toEqual({ refuse: false });
  });

  it("fails open when root matching throws after a successful state read", async () => {
    const result = await resolveLiveManagedGatewayDistFence("/srv/openclaw", {
      readState: async () => baseState({ running: true }),
      matchesRoot: async () => {
        throw new Error("realpath failed");
      },
    });
    expect(result).toEqual({ refuse: false });
  });
});

async function writeOpenClawPackage(packageRoot: string) {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}\n');
  await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "gateway\n");
}

describe("live-gateway-dist-fence physical overlap", () => {
  it("refuses when the serving entrypoint is this checkout's dist", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-physical-" }, async (tmp) => {
      await writeOpenClawPackage(tmp);
      const result = await resolveLiveManagedGatewayDistFence(tmp, {
        readState: async () =>
          baseState({
            running: true,
            command: {
              programArguments: [process.execPath, path.join(tmp, "dist", "index.js"), "gateway"],
            },
          }),
      });
      expect(result.refuse).toBe(true);
    });
  });

  it("allows a logically owned current/releases tree whose dist is physically separate", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-release-" }, async (tmp) => {
      const managedRoot = path.join(tmp, "openclaw");
      const release = path.join(tmp, "releases", "selected");
      const current = path.join(tmp, "current");
      await writeOpenClawPackage(managedRoot);
      await writeOpenClawPackage(release);
      await fs.symlink(release, current);
      const command = {
        programArguments: [process.execPath, path.join(current, "dist", "index.js"), "gateway"],
        managedDefinition: {
          programArguments: [
            process.execPath,
            path.join(managedRoot, "dist", "index.js"),
            "gateway",
          ],
        },
      };
      await expect(
        gatewayServiceCommandOverlapsPhysicalCheckout(managedRoot, command),
      ).resolves.toBe(false);
      const result = await resolveLiveManagedGatewayDistFence(managedRoot, {
        readState: async () => baseState({ running: true, command }),
      });
      expect(result).toEqual({ refuse: false });
    });
  });

  it("refuses when the checkout is the physical release behind current", async () => {
    await withTestDir({ prefix: "openclaw-live-dist-release-self-" }, async (tmp) => {
      const release = path.join(tmp, "releases", "selected");
      const current = path.join(tmp, "current");
      await writeOpenClawPackage(release);
      await fs.symlink(release, current);
      const result = await resolveLiveManagedGatewayDistFence(release, {
        readState: async () =>
          baseState({
            running: true,
            command: {
              programArguments: [
                process.execPath,
                path.join(current, "dist", "index.js"),
                "gateway",
              ],
            },
          }),
      });
      expect(result.refuse).toBe(true);
    });
  });
});
