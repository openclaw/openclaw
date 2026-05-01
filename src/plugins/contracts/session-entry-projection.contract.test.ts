import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { runPluginHostCleanup } from "../host-hook-cleanup.js";
import { clearPluginHostRuntimeState } from "../host-hook-runtime.js";
import { patchPluginSessionExtension } from "../host-hook-state.js";
import type { PluginJsonValue } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";

describe("plugin session extension SessionEntry projection", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
  });

  it("mirrors projected values to SessionEntry[slotKey] and clears them on unset", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "promoted-plugin", name: "Promoted" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
          sessionEntrySlotSchema: { type: "object" },
          project: (ctx) => {
            if (!ctx.state || typeof ctx.state !== "object" || Array.isArray(ctx.state)) {
              return undefined;
            }
            const state = ctx.state as Record<string, PluginJsonValue>;
            return { state: state.state ?? null, title: state.title ?? null };
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });

          const patchResult = await patchPluginSessionExtension({
            cfg: tempConfig as never,
            sessionKey: "agent:main:main",
            pluginId: "promoted-plugin",
            namespace: "workflow",
            value: { state: "executing", title: "Deploy approval", internal: 7 },
          });
          expect(patchResult.ok).toBe(true);
          const afterPatch = loadSessionStore(storePath, { skipCache: true });
          expect(
            (afterPatch["agent:main:main"] as unknown as Record<string, unknown>).approvalSnapshot,
          ).toEqual({ state: "executing", title: "Deploy approval" });

          const unsetResult = await patchPluginSessionExtension({
            cfg: tempConfig as never,
            sessionKey: "agent:main:main",
            pluginId: "promoted-plugin",
            namespace: "workflow",
            unset: true,
          });
          expect(unsetResult.ok).toBe(true);
          const afterUnset = loadSessionStore(storePath, { skipCache: true });
          expect(
            (afterUnset["agent:main:main"] as unknown as Record<string, unknown>).approvalSnapshot,
          ).toBeUndefined();
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects sessionEntrySlotKey values that collide with SessionEntry fields", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "slot-collision", name: "Slot Collision" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "bad slot",
          sessionEntrySlotKey: "updatedAt",
        });
        api.registerSessionExtension({
          namespace: "recovery",
          description: "bad fresh-main slot",
          sessionEntrySlotKey: "subagentRecovery",
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "slot-collision",
          message: "sessionEntrySlotKey is reserved by SessionEntry: updatedAt",
        }),
        expect.objectContaining({
          pluginId: "slot-collision",
          message: "sessionEntrySlotKey is reserved by SessionEntry: subagentRecovery",
        }),
      ]),
    );
  });

  it("clears promoted SessionEntry slots with plugin-owned session state", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "cleanup-promoted-plugin", name: "Cleanup" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "promoted workflow",
          sessionEntrySlotKey: "approvalSnapshot",
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-cleanup-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expect(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "cleanup-promoted-plugin",
              namespace: "workflow",
              value: { state: "waiting" },
            }),
          ).resolves.toMatchObject({ ok: true });

          await expect(
            runPluginHostCleanup({
              cfg: tempConfig as never,
              registry: registry.registry,
              pluginId: "cleanup-promoted-plugin",
              reason: "delete",
            }),
          ).resolves.toMatchObject({ failures: [] });

          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.pluginExtensions).toBeUndefined();
          expect(entry.approvalSnapshot).toBeUndefined();
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("exposes scoped session extension reads to trusted tool policies", async () => {
    const seen: unknown[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "policy-plugin",
        name: "Policy Plugin",
        origin: "bundled",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "policy",
          description: "policy state",
        });
        api.registerTrustedToolPolicy({
          id: "inspect-session-state",
          description: "inspect session extension",
          evaluate(_event, ctx) {
            seen.push(ctx.getSessionExtension?.("policy"));
            return undefined;
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-policy-read-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          await expect(
            patchPluginSessionExtension({
              cfg: tempConfig as never,
              sessionKey: "agent:main:main",
              pluginId: "policy-plugin",
              namespace: "policy",
              value: { gate: "open" },
            }),
          ).resolves.toMatchObject({ ok: true });

          await expect(
            runTrustedToolPolicies(
              { toolName: "apply_patch", params: {} },
              {
                toolName: "apply_patch",
                sessionKey: "agent:main:main",
                config: tempConfig as never,
              },
            ),
          ).resolves.toBeUndefined();

          await expect(
            runTrustedToolPolicies(
              { toolName: "apply_patch", params: {} },
              {
                toolName: "apply_patch",
                sessionKey: "agent:main:main",
              },
            ),
          ).resolves.toBeUndefined();
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }

    expect(seen).toEqual([{ gate: "open" }, undefined]);
  });

  it("does not touch top-level SessionEntry slots when sessionEntrySlotKey is omitted", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "non-promoted-plugin", name: "Non" }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "non-promoted workflow",
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-slot-noop-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const tempConfig = { session: { store: storePath } };
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-id",
              updatedAt: Date.now(),
            } as unknown as SessionEntry;
          });
          const result = await patchPluginSessionExtension({
            cfg: tempConfig as never,
            sessionKey: "agent:main:main",
            pluginId: "non-promoted-plugin",
            namespace: "workflow",
            value: { state: "executing" },
          });
          expect(result.ok).toBe(true);
          const stored = loadSessionStore(storePath, { skipCache: true });
          const entry = stored["agent:main:main"] as unknown as Record<string, unknown>;
          expect(entry.approvalSnapshot).toBeUndefined();
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
