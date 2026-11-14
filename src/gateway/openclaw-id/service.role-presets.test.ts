import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerConfigWriteListener } from "../../config/io.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type {
  GatewayOperatorRoleDefinition,
  GatewayOperatorRolesConfig,
} from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createOpenClawIdService } from "./service.js";

const presets: Record<"operator" | "viewer" | "guest", GatewayOperatorRoleDefinition> = {
  operator: {
    sessions: { others: "write" },
    agents: "*",
    scopes: [
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.talk",
    ],
  },
  guest: {
    sessions: { others: "view" },
    agents: "*",
    scopes: ["operator.sessions.write"],
    sandbox: "required",
  },
  viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.sessions.read"] },
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) {
    await stop();
  }
  await closeOpenClawStateDatabaseAsync();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

async function fixture(initial: OpenClawConfig) {
  const stateDir = tempDirs.make("openclaw-id-role-presets-");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  let config = initial;
  await fs.writeFile(configPath, JSON.stringify(config));
  setRuntimeConfigSnapshot(config, config);
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createOpenClawIdService({
    getConfig: () => config.gateway?.openclawId,
    getStateDir: () => stateDir,
    getGatewayServer: () => undefined,
    log,
  });
  cleanup.push(() => service.stop());
  return {
    service,
    log,
    configPath,
    read: async (): Promise<OpenClawConfig> => JSON.parse(await fs.readFile(configPath, "utf8")),
    setRuntime(next: OpenClawConfig) {
      config = next;
      setRuntimeConfigSnapshot(config, config);
    },
    async save(next: OpenClawConfig) {
      await fs.writeFile(configPath, JSON.stringify(next));
      this.setRuntime(next);
    },
  };
}

describe("OpenClaw ID member role preset activation", () => {
  it.each([true, false])("seeds missing presets (enabled at startup: %s)", async (enabled) => {
    const f = await fixture({ gateway: { openclawId: { enabled } } });
    if (!enabled) {
      await f.service.reconcileRuntimePolicy();
      expect((await f.read()).gateway?.roles).toBeUndefined();
      await f.save({ gateway: { openclawId: { enabled: true } } });
    }
    await f.service.reconcileRuntimePolicy();
    expect((await f.read()).gateway?.roles).toEqual({ definitions: presets });
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it("preserves edited presets, custom roles, default and assignments; skips no-op writes", async () => {
    const roles: GatewayOperatorRolesConfig = {
      default: "custom",
      assignments: { byGithubLogin: { maintainer: "custom" } },
      definitions: {
        operator: { ...presets.viewer },
        guest: { ...presets.operator },
        custom: { sessions: { others: "none" }, agents: "*", scopes: ["operator.admin"] },
      },
    };
    const f = await fixture({ gateway: { openclawId: { enabled: true }, roles } });
    await f.service.reconcileRuntimePolicy();
    expect((await f.read()).gateway?.roles).toEqual({
      ...roles,
      definitions: { ...roles.definitions, viewer: presets.viewer },
    });
    const seeded = await f.read();
    await f.save({ ...seeded, gateway: { ...seeded.gateway, openclawId: { enabled: false } } });
    await f.service.reconcileRuntimePolicy();
    await f.save(seeded);
    const before = await fs.readFile(f.configPath, "utf8");
    await f.service.reconcileRuntimePolicy();
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
  });

  it("does not restore deleted presets on ordinary reloads, but seeds on reactivation", async () => {
    const f = await fixture({ gateway: { openclawId: { enabled: true } } });
    await f.service.reconcileRuntimePolicy();
    const edited: OpenClawConfig = {
      gateway: {
        openclawId: { enabled: true },
        roles: { definitions: { operator: { ...presets.viewer } } },
      },
    };
    await f.save(edited);
    await f.service.reconcileRuntimePolicy();
    await f.service.reconcileRuntimePolicy();
    expect((await f.read()).gateway?.roles).toEqual(edited.gateway?.roles);
    await f.save({ gateway: { ...edited.gateway, openclawId: { enabled: false } } });
    await f.service.reconcileRuntimePolicy();
    await f.save(edited);
    await f.service.reconcileRuntimePolicy();
    expect((await f.read()).gateway?.roles?.definitions.viewer).toEqual(presets.viewer);
    expect((await f.read()).gateway?.roles?.definitions.guest).toEqual(presets.guest);
  });

  it("does not write with OpenClaw ID off or after the service stops", async () => {
    const f = await fixture({ gateway: { openclawId: { enabled: false } } });
    const before = await fs.readFile(f.configPath, "utf8");
    await f.service.reconcileRuntimePolicy();
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
    await f.service.stop();
    await f.save({ gateway: { openclawId: { enabled: true } } });
    await f.service.reconcileRuntimePolicy();
    expect((await f.read()).gateway?.roles).toBeUndefined();
  });

  it("shows a failed preset write without refusing owners or retrying ordinary reloads", async () => {
    const f = await fixture({ gateway: { openclawId: { enabled: true } } });
    const preflight = vi.fn(async () => {
      throw new Error("preset write refused");
    });
    cleanup.push(
      registerConfigWriteListener(() => {}, {
        ownsRuntimeActivationFor: f.configPath,
        preCommitRuntimePreflight: preflight,
      }),
    );
    await f.service.reconcileRuntimePolicy();
    expect(f.service.status()).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("preset write refused"),
    });
    expect(f.log.warn).toHaveBeenCalledWith(expect.stringContaining("preset write refused"));
    expect((await f.read()).gateway?.roles).toBeUndefined();
    expect(await f.service.isOwnerClient("local_operator", undefined)).toBe(true);
    await f.service.reconcileRuntimePolicy();
    expect(preflight).toHaveBeenCalledOnce();
    await f.save({ gateway: { openclawId: { enabled: false } } });
    await f.service.reconcileRuntimePolicy();
    expect(f.service.status()).toEqual({ state: "off" });
  });

  it("publishes through managed config IO without awaiting its recursive reconcile", async () => {
    const f = await fixture({ gateway: { openclawId: { enabled: true } } });
    let recursive: Promise<void> | undefined;
    const writes = vi.fn(
      (event: Parameters<Parameters<typeof registerConfigWriteListener>[0]>[0]) => {
        f.setRuntime(event.runtimeConfig);
        recursive = f.service.reconcileRuntimePolicy();
      },
    );
    cleanup.push(
      registerConfigWriteListener(writes, {
        ownsRuntimeActivationFor: f.configPath,
        preCommitRuntimePreflight: async (config) => ({
          runtimeConfig: config,
          compareConfig: config,
        }),
      }),
    );
    await f.service.reconcileRuntimePolicy();
    await recursive;
    expect(writes).toHaveBeenCalledOnce();
    expect((await f.read()).gateway?.roles).toEqual({ definitions: presets });
    expect(f.log.warn).not.toHaveBeenCalled();
  });
});
