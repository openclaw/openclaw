import path from "node:path";
// Session entry projection contract tests cover plugin session entry projection behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessionEntriesCore } from "../../config/sessions/session-accessor.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createPluginHostRegistryRetirement, runPluginHostCleanup } from "../host-hook-cleanup.js";
import { clearPluginHostRuntimeState } from "../host-hook-runtime.js";
import { patchPluginSessionExtension } from "../host-hook-state.js";
import type { PluginJsonValue } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { registrationFixture } from "../registry-registration.test-support.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../runtime.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";
import { seedPluginSessionEntry } from "./test-helpers/session-entry.js";

const requireRecord = createRequireRecord("object", "expected-label");

async function expectOkResult(promise: Promise<unknown>, label: string) {
  const result = requireRecord(await promise, label);
  expect(result.ok).toBe(true);
  return result;
}

async function expectNoCleanupFailures(promise: Promise<unknown>, label: string) {
  const result = requireRecord(await promise, label);
  expect(result.failures).toEqual([]);
  return result;
}

function extensionNamespace(entry: Record<string, unknown>, pluginId: string, namespace: string) {
  const extensions = requireRecord(entry.pluginExtensions, "plugin extensions");
  const pluginExtensions = requireRecord(extensions[pluginId], `${pluginId} extensions`);
  return requireRecord(pluginExtensions[namespace], `${pluginId}.${namespace} state`);
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-host-hooks-slot-");

async function withProjectionSessionStore(
  run: (fixture: {
    storePath: string;
    tempConfig: { session: { store: string } };
    patch: (
      params: Omit<Parameters<typeof patchPluginSessionExtension>[0], "cfg" | "sessionKey">,
    ) => ReturnType<typeof patchPluginSessionExtension>;
    readEntry: () => Record<string, unknown>;
  }) => Promise<void>,
): Promise<void> {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, "sessions.json");
  const tempConfig = {
    agents: { entries: { main: {} } },
    session: { store: storePath },
  };
  return await withEnvAsync(
    { OPENCLAW_STATE_DIR: stateDir },
    async () =>
      await withTempConfig({
        cfg: tempConfig,
        run: async () => {
          try {
            await run({
              storePath,
              tempConfig,
              patch: (params) =>
                patchPluginSessionExtension({
                  cfg: tempConfig as never,
                  sessionKey: "agent:main:main",
                  ...params,
                }),
              readEntry: () =>
                Object.fromEntries(
                  listSessionEntriesCore({ agentId: "main", storePath }).map(
                    ({ sessionKey, entry }) => [sessionKey, entry],
                  ),
                )["agent:main:main"] as unknown as Record<string, unknown>,
            });
          } finally {
            // Retired hooks must finish before their state directory and config change.
            setActivePluginRegistry(createEmptyPluginRegistry());
            await clearActivePluginRegistry();
          }
        },
      }),
  );
}

function registerProjectionSlots(pluginId: string, slots: Record<string, string | undefined>) {
  const { registry, register } = registrationFixture();
  register({ id: pluginId, name: pluginId }, (api) => {
    for (const [namespace, sessionEntrySlotKey] of Object.entries(slots)) {
      api.registerSessionExtension({
        namespace,
        description: `${namespace} state`,
        ...(sessionEntrySlotKey === undefined ? {} : { sessionEntrySlotKey }),
      });
    }
  });
  return registry;
}

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
    const { registry, register } = registrationFixture();
    register({ id: "promoted-plugin", name: "Promoted" }, (api) => {
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
    });
    setActivePluginRegistry(registry);

    await withProjectionSessionStore(async ({ storePath, patch, readEntry }) => {
      await seedPluginSessionEntry(storePath);

      const patchResult = await patch({
        pluginId: "promoted-plugin",
        namespace: "workflow",
        value: { state: "executing", title: "Deploy approval", internal: 7 },
      });
      expect(patchResult.ok).toBe(true);
      const afterPatch = readEntry();
      expect(afterPatch.approvalSnapshot).toEqual({ state: "executing", title: "Deploy approval" });

      const unsetResult = await patch({
        pluginId: "promoted-plugin",
        namespace: "workflow",
        unset: true,
      });
      expect(unsetResult.ok).toBe(true);
      const afterUnset = readEntry();
      expect(afterUnset.approvalSnapshot).toBeUndefined();
    });
  });

  it("clears promoted SessionEntry slots when projectors fail", async () => {
    const { registry, register } = registrationFixture();
    register({ id: "failing-promoted-plugin", name: "Failing" }, (api) => {
      api.registerSessionExtension({
        namespace: "workflow",
        description: "promoted workflow",
        sessionEntrySlotKey: "approvalSnapshot",
        sessionEntrySlotSchema: { type: "object" },
        project: (ctx) => {
          const state = ctx.state as Record<string, PluginJsonValue>;
          if (state.fail === "throw") {
            throw new Error("projection failed");
          }
          if (state.fail === "promise") {
            return Promise.resolve({ state: "async" }) as never;
          }
          return { state: state.state ?? null };
        },
      });
    });
    setActivePluginRegistry(registry);

    await withProjectionSessionStore(async ({ storePath, patch, readEntry }) => {
      await seedPluginSessionEntry(storePath);

      for (const [readyState, badState, fail] of [
        ["ready", "bad", "throw"],
        ["ready-again", "async-bad", "promise"],
      ] as const) {
        await expectOkResult(
          patch({
            pluginId: "failing-promoted-plugin",
            namespace: "workflow",
            value: { state: readyState },
          }),
          `${readyState} patch result`,
        );
        expect(readEntry().approvalSnapshot).toEqual({ state: readyState });
        await expectOkResult(
          patch({
            pluginId: "failing-promoted-plugin",
            namespace: "workflow",
            value: { state: badState, fail },
          }),
          `${fail} projector patch result`,
        );
        const entry = readEntry();
        expect(entry.approvalSnapshot).toBeUndefined();
        expect(extensionNamespace(entry, "failing-promoted-plugin", "workflow")).toEqual({
          state: badState,
          fail,
        });
      }
    });
  });

  it("rejects sessionEntrySlotKey values that collide with SessionEntry fields", () => {
    const reservedSlots = {
      workflow: "updatedAt",
      "main-recovery": "mainRestartRecovery",
      "requester-source": "restartRecoveryRequesterSource",
      recovery: "subagentRecovery",
      "run-error": "lastRunError",
      "transcript-path": "transcriptPath",
      "custom-icon": "icon",
      "context-window-source": "contextTokensSource",
      "sandbox-policy": "sandbox",
      "pending-final-text": "pendingFinalDeliveryText",
      "completion-custody": "restartRecoveryHarnessCompletion",
      "retired-execsecurity": "execSecurity",
      "retired-execask": "execAsk",
      "retired-conversation-link": "conversationLink",
    };
    const { registry, register } = registrationFixture();
    register({ id: "slot-collision", name: "Slot Collision" }, (api) => {
      for (const [namespace, sessionEntrySlotKey] of Object.entries(reservedSlots)) {
        api.registerSessionExtension({
          namespace,
          description: "reserved session field",
          sessionEntrySlotKey,
        });
      }
    });

    expect(registry.sessionExtensions).toHaveLength(0);
    expect(
      registry.diagnostics.map(({ pluginId, message }) => ({ pluginId, message })),
    ).toStrictEqual(
      Object.values(reservedSlots).map((slotKey) => ({
        pluginId: "slot-collision",
        message: `sessionEntrySlotKey is reserved by SessionEntry: ${slotKey}`,
      })),
    );
  });

  it("rejects sessionEntrySlotKey values inherited from Object.prototype", () => {
    const reservedSlots = {
      "to-string": "toString",
      "has-own": "hasOwnProperty",
      "value-of": "valueOf",
    };
    const { registry, register } = registrationFixture();
    register({ id: "object-slot-collision", name: "Object Slot Collision" }, (api) => {
      for (const [namespace, sessionEntrySlotKey] of Object.entries(reservedSlots)) {
        api.registerSessionExtension({
          namespace,
          description: "bad object slot",
          sessionEntrySlotKey,
        });
      }
    });

    expect(registry.sessionExtensions).toHaveLength(0);
    expect(
      registry.diagnostics.map(({ pluginId, message }) => ({ pluginId, message })),
    ).toStrictEqual(
      Object.values(reservedSlots).map((slotKey) => ({
        pluginId: "object-slot-collision",
        message: `sessionEntrySlotKey is reserved by Object: ${slotKey}`,
      })),
    );
  });

  it("rejects duplicate promoted SessionEntry slot keys across registrations", () => {
    const { registry, register } = registrationFixture();
    register({ id: "slot-owner", name: "Slot Owner" }, (api) => {
      api.registerSessionExtension({
        namespace: "workflow",
        description: "first promoted slot",
        sessionEntrySlotKey: "approvalSnapshot",
      });
      api.registerSessionExtension({
        namespace: "recovery",
        description: "same plugin duplicate slot",
        sessionEntrySlotKey: " approvalSnapshot ",
      });
    });
    register({ id: "slot-colliding-plugin", name: "Slot Colliding" }, (api) => {
      api.registerSessionExtension({
        namespace: "workflow",
        description: "cross-plugin duplicate slot",
        sessionEntrySlotKey: "approvalSnapshot",
      });
    });

    expect(registry.sessionExtensions).toHaveLength(1);
    expect(registry.sessionExtensions[0]?.extension.sessionEntrySlotKey).toBe("approvalSnapshot");
    const diagnostics = registry.diagnostics.map(({ pluginId, message }) => ({
      pluginId,
      message,
    }));
    expect(diagnostics).toStrictEqual([
      {
        pluginId: "slot-owner",
        message: "sessionEntrySlotKey already registered: approvalSnapshot",
      },
      {
        pluginId: "slot-colliding-plugin",
        message: "sessionEntrySlotKey already registered: approvalSnapshot",
      },
    ]);
  });

  it.each(["explicit", "active"] as const)(
    "clears promoted SessionEntry slots and plugin state using the %s registry",
    async (registrySource) => {
      const pluginId = "cleanup-promoted-plugin";
      const registry = registerProjectionSlots(pluginId, { workflow: "approvalSnapshot" });
      setActivePluginRegistry(registry);
      await withProjectionSessionStore(async ({ storePath, tempConfig, patch, readEntry }) => {
        await seedPluginSessionEntry(storePath);
        await expectOkResult(
          patch({ pluginId, namespace: "workflow", value: { state: "waiting" } }),
          "cleanup patch result",
        );
        await expectNoCleanupFailures(
          runPluginHostCleanup({
            cfg: tempConfig as never,
            ...(registrySource === "explicit" ? { registry } : {}),
            pluginId,
            reason: "delete",
          }),
          "cleanup result",
        );
        const entry = readEntry();
        expect(entry.pluginExtensions).toBeUndefined();
        expect(entry.approvalSnapshot).toBeUndefined();
      });
    },
  );

  it.each([
    {
      name: "removed slot",
      previousSlots: { workflow: "approvalSnapshot" },
      nextSlots: { workflow: undefined },
      values: { workflow: { state: "waiting" } },
      expectedApproval: undefined,
      expectedSlots: undefined,
      expectedState: { workflow: { state: "waiting" } },
    },
    {
      name: "mixed retained and removed slots",
      previousSlots: { workflow: "approvalSnapshot", legacy: "legacyApprovalSnapshot" },
      nextSlots: { workflow: "approvalSnapshot", legacy: undefined },
      values: { workflow: { state: "waiting" }, legacy: { state: "legacy" } },
      expectedApproval: { state: "waiting" },
      expectedSlots: { workflow: "approvalSnapshot" },
      expectedState: { workflow: { state: "waiting" }, legacy: { state: "legacy" } },
    },
    {
      name: "retained slot",
      previousSlots: { workflow: "approvalSnapshot" },
      nextSlots: { workflow: "approvalSnapshot" },
      values: { workflow: { state: "waiting" } },
      expectedApproval: { state: "waiting" },
      expectedSlots: { workflow: "approvalSnapshot" },
      expectedState: { workflow: { state: "waiting" } },
    },
  ])("retires only stale promoted slots on restart: $name", async (scenario) => {
    const pluginId = "restart-promoted-plugin";
    const previousRegistry = registerProjectionSlots(pluginId, scenario.previousSlots);
    const nextRegistry = registerProjectionSlots(pluginId, scenario.nextSlots);
    setActivePluginRegistry(previousRegistry);
    await withProjectionSessionStore(async ({ storePath, tempConfig, patch, readEntry }) => {
      await seedPluginSessionEntry(storePath);
      for (const [namespace, value] of Object.entries(scenario.values)) {
        await expectOkResult(patch({ pluginId, namespace, value }), `${namespace} restart patch`);
      }
      await expectNoCleanupFailures(
        createPluginHostRegistryRetirement({
          cfg: tempConfig as never,
          previousRegistry,
          nextRegistry,
        })(),
        "restart cleanup result",
      );
      const entry = readEntry();
      expect(entry.approvalSnapshot).toEqual(scenario.expectedApproval);
      expect(entry.legacyApprovalSnapshot).toBeUndefined();
      expect(entry.pluginExtensionSlotKeys).toEqual(
        scenario.expectedSlots ? { [pluginId]: scenario.expectedSlots } : undefined,
      );
      expect(entry.pluginExtensions).toEqual({ [pluginId]: scenario.expectedState });
    });
  });

  it("clears persisted promoted slots when registry metadata is unavailable", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    await withProjectionSessionStore(async ({ storePath, tempConfig, readEntry }) => {
      await seedPluginSessionEntry(storePath, {
        pluginExtensions: {
          "removed-promoted-plugin": {
            workflow: { state: "stale" },
          },
        },
        pluginExtensionSlotKeys: {
          "removed-promoted-plugin": {
            workflow: "approvalSnapshot",
          },
        },
        approvalSnapshot: { state: "stale" },
      });

      await expectNoCleanupFailures(
        runPluginHostCleanup({
          cfg: tempConfig as never,
          pluginId: "removed-promoted-plugin",
          reason: "delete",
        }),
        "metadata cleanup result",
      );

      const entry = readEntry();
      expect(entry.approvalSnapshot).toBeUndefined();
      expect(entry.pluginExtensionSlotKeys).toBeUndefined();
      expect(entry.pluginExtensions).toBeUndefined();
    });
  });

  it("exposes scoped session extension reads to trusted tool policies", async () => {
    const seen: unknown[] = [];
    const seenConfig: unknown[] = [];
    const { registry, register } = registrationFixture();
    register(
      {
        id: "policy-plugin",
        name: "Policy Plugin",
        origin: "bundled",
      },
      (api) => {
        api.registerSessionExtension({
          namespace: "policy",
          description: "policy state",
        });
        api.registerSessionExtension({
          namespace: "second",
          description: "second policy state",
        });
        api.registerTrustedToolPolicy({
          id: "inspect-session-state",
          description: "inspect session extension",
          evaluate(eventValue, ctx) {
            seen.push(ctx.getSessionExtension?.("policy"));
            seen.push(ctx.getSessionExtension?.("second"));
            seen.push(ctx.getSessionExtension?.("missing"));
            seenConfig.push((ctx as { config?: unknown }).config);
            return undefined;
          },
        });
      },
    );
    setActivePluginRegistry(registry);

    await withProjectionSessionStore(async ({ storePath, tempConfig, patch }) => {
      await seedPluginSessionEntry(storePath);
      await expectOkResult(
        patch({
          pluginId: "policy-plugin",
          namespace: "policy",
          value: { gate: "open" },
        }),
        "policy patch result",
      );
      await expectOkResult(
        patch({
          pluginId: "policy-plugin",
          namespace: "second",
          value: { gate: "second" },
        }),
        "second policy patch result",
      );

      await expect(
        runTrustedToolPolicies(
          { toolName: "apply_patch", params: {} },
          {
            toolName: "apply_patch",
            sessionKey: "agent:main:main",
          },
          { config: tempConfig as never },
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
    });

    expect(seen).toEqual([
      { gate: "open" },
      { gate: "second" },
      undefined,
      { gate: "open" },
      { gate: "second" },
      undefined,
    ]);
    expect(seenConfig).toEqual([undefined, undefined]);
  });

  it("does not touch top-level SessionEntry slots when sessionEntrySlotKey is omitted", async () => {
    const { registry, register } = registrationFixture();
    register({ id: "non-promoted-plugin", name: "Non" }, (api) => {
      api.registerSessionExtension({
        namespace: "workflow",
        description: "non-promoted workflow",
      });
    });
    setActivePluginRegistry(registry);

    await withProjectionSessionStore(async ({ storePath, patch, readEntry }) => {
      await seedPluginSessionEntry(storePath);
      const result = await patch({
        pluginId: "non-promoted-plugin",
        namespace: "workflow",
        value: { state: "executing" },
      });
      expect(result.ok).toBe(true);
      const entry = readEntry();
      expect(entry.approvalSnapshot).toBeUndefined();
    });
  });
});
