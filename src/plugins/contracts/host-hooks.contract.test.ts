import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../../../test/helpers/plugins/contracts-testkit.js";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import {
  validatePluginsUiDescriptorsParams,
  validateSessionsPluginPatchParams,
} from "../../gateway/protocol/index.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { executePluginCommand } from "../commands.js";
import { createHookRunner } from "../hooks.js";
import {
  cleanupReplacedPluginHostRegistry,
  clearPluginOwnedSessionState,
  runPluginHostCleanup,
} from "../host-hook-cleanup.js";
import {
  clearPluginHostRuntimeState,
  getPluginRunContext,
  listPluginSessionSchedulerJobs,
} from "../host-hook-runtime.js";
import {
  drainPluginNextTurnInjections,
  enqueuePluginNextTurnInjection,
  patchPluginSessionExtension,
  projectPluginSessionExtensions,
  projectPluginSessionExtensionsSync,
} from "../host-hook-state.js";
import { buildPluginAgentTurnPrepareContext, isPluginJsonValue } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";
import { registerHostHookFixture, registerTrustedHostHookFixture } from "./host-hook-fixture.js";

describe("host-hook fixture plugin contract", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("registers generic SDK seams without Plan Mode business logic", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
        origin: "workspace",
      }),
      register: registerHostHookFixture,
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(1);
    expect(registry.registry.toolMetadata ?? []).toHaveLength(1);
    expect(registry.registry.controlUiDescriptors ?? []).toHaveLength(1);
    expect(registry.registry.runtimeLifecycles ?? []).toHaveLength(1);
    expect(registry.registry.agentEventSubscriptions ?? []).toHaveLength(1);
    expect(registry.registry.sessionSchedulerJobs ?? []).toHaveLength(1);
    expect(registry.registry.commands.map((entry) => entry.command.name)).toEqual([
      "host-hook-fixture",
    ]);
    expect(registry.registry.typedHooks.map((entry) => entry.hookName).toSorted()).toEqual([
      "agent_turn_prepare",
      "heartbeat_prompt_contribution",
    ]);
  });

  it("rejects external plugins from trusted policy and reserved command ownership", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "external-policy",
        name: "External Policy",
        origin: "workspace",
      }),
      register(api) {
        api.registerTrustedToolPolicy({
          id: "deny",
          description: "Should not be accepted",
          evaluate: () => undefined,
        });
        api.registerCommand({
          name: "status",
          description: "Should not be accepted",
          ownership: "reserved",
          handler: async () => ({ text: "no" }),
        });
      },
    });

    expect(registry.registry.trustedToolPolicies ?? []).toHaveLength(0);
    expect(registry.registry.commands).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "external-policy",
          message: expect.stringContaining("only bundled plugins can register trusted tool"),
        }),
        expect.objectContaining({
          pluginId: "external-policy",
          message: expect.stringContaining("only bundled plugins can claim reserved command"),
        }),
      ]),
    );
  });

  it("lets bundled fixture policies run before normal before_tool_call hooks", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "trusted-fixture",
        name: "Trusted Fixture",
        origin: "bundled",
      }),
      register: registerTrustedHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      runTrustedToolPolicies(
        { toolName: "blocked_fixture_tool", params: {} },
        { toolName: "blocked_fixture_tool" },
      ),
    ).resolves.toMatchObject({
      block: true,
      blockReason: "blocked by fixture policy",
    });
  });

  it("validates plugin-owned JSON values as plain JSON-compatible data", () => {
    expect(
      isPluginJsonValue({
        state: "waiting",
        attempts: 1,
        nested: [{ ok: true }, null],
      }),
    ).toBe(true);
    expect(isPluginJsonValue({ value: Number.NaN })).toBe(false);
    expect(isPluginJsonValue({ value: undefined })).toBe(false);
    expect(isPluginJsonValue(new Date(0))).toBe(false);
    expect(isPluginJsonValue(new Map([["state", "waiting"]]))).toBe(false);
  });

  it("rejects non-JSON descriptor schemas before projecting Control UI descriptors", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "descriptor-fixture",
        name: "Descriptor Fixture",
      }),
      register(api) {
        api.registerControlUiDescriptor({
          id: "bad-schema",
          surface: "session",
          label: "Bad schema",
          schema: new Date(0) as never,
        });
      },
    });

    expect(registry.registry.controlUiDescriptors ?? []).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "descriptor-fixture",
          message: "control UI descriptor schema must be JSON-compatible: bad-schema",
        }),
      ]),
    );
  });

  it("projects registered session extensions into gateway session rows", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    const row = buildGatewaySessionRow({
      cfg: config,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        pluginExtensions: {
          "host-hook-fixture": {
            workflow: { state: "waiting" },
          },
        },
      },
    });

    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "host-hook-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);
  });

  it("projects sync session extension projectors into gateway rows without exposing raw state", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "projector-fixture",
        name: "Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Projected workflow state",
          project: ({ state }) => {
            if (!state || typeof state !== "object" || Array.isArray(state)) {
              return undefined;
            }
            const workflowState = (state as { state?: unknown }).state;
            return typeof workflowState === "string" ? { state: workflowState } : undefined;
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "projector-fixture": {
          workflow: { state: "waiting", privateToken: "secret" },
        },
      },
    };
    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual([
      {
        pluginId: "projector-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);

    const row = buildGatewaySessionRow({
      cfg: config,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry,
    });
    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "projector-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);
  });

  it("rejects async session extension projectors because gateway rows are synchronous", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "async-projector-fixture",
        name: "Async Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Async workflow state",
          project: (async () => ({ state: "late" })) as unknown as () => undefined,
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "async-projector-fixture",
          message: "session extension projector must be synchronous",
        }),
      ]),
    );
  });

  it("defensively ignores promise-like session projections from untyped plugins", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "promise-projector-fixture",
        name: "Promise Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Promise workflow state",
          project: (() =>
            Promise.reject(
              new Error("projectors must be synchronous"),
            )) as unknown as () => undefined,
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "promise-projector-fixture": {
          workflow: { state: "waiting" },
        },
      },
    };

    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual(
      [],
    );
    await expect(
      projectPluginSessionExtensions({ sessionKey: "agent:main:main", entry }),
    ).resolves.toEqual([]);
  });

  it("skips throwing session extension projectors without losing other projections", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "throwing-projector-fixture",
        name: "Throwing Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Throwing workflow state",
          project: () => {
            throw new Error("projection failed");
          },
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "healthy-projector-fixture",
        name: "Healthy Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Healthy workflow state",
          project: ({ state }) => state,
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "throwing-projector-fixture": {
          workflow: { state: "hidden" },
        },
        "healthy-projector-fixture": {
          workflow: { state: "visible" },
        },
      },
    };

    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual([
      {
        pluginId: "healthy-projector-fixture",
        namespace: "workflow",
        value: { state: "visible" },
      },
    ]);
    const row = buildGatewaySessionRow({
      cfg: config,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry,
    });
    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "healthy-projector-fixture",
        namespace: "workflow",
        value: { state: "visible" },
      },
    ]);
  });

  it("requires explicit unset to remove plugin session extension state", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "patch-fixture",
        name: "Patch Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Patch workflow state",
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-patch-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: {
          session: { store: storePath },
        },
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginExtensions: {
                "patch-fixture": { workflow: { state: "waiting" } },
              },
            };
            return undefined;
          });

          await expect(
            patchPluginSessionExtension({
              sessionKey: "agent:main:main",
              pluginId: "patch-fixture",
              namespace: "workflow",
            }),
          ).resolves.toEqual({
            ok: false,
            error: "plugin session extension value is required unless unset is true",
          });
          expect(
            loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions?.["patch-fixture"]
              ?.workflow,
          ).toEqual({ state: "waiting" });

          await expect(
            patchPluginSessionExtension({
              sessionKey: "agent:main:main",
              pluginId: "patch-fixture",
              namespace: "workflow",
              value: { state: "approved" },
            }),
          ).resolves.toEqual({
            ok: true,
            key: "agent:main:main",
            value: { state: "approved" },
          });

          await expect(
            patchPluginSessionExtension({
              sessionKey: "agent:main:main",
              pluginId: "patch-fixture",
              namespace: "workflow",
              unset: true,
            }),
          ).resolves.toEqual({
            ok: true,
            key: "agent:main:main",
            value: undefined,
          });
          expect(loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions).toBeUndefined();
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

  it("models queued next-turn injections and agent_turn_prepare as one prompt context", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    const runner = createHookRunner(registry.registry);
    const queuedContext = buildPluginAgentTurnPrepareContext({
      queuedInjections: [
        {
          id: "approval",
          pluginId: "approval-plugin",
          text: "approval workflow resumed",
          placement: "prepend_context",
          createdAt: 1,
        },
        {
          id: "budget",
          pluginId: "budget-plugin",
          text: "budget policy summary",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });
    const hookContext = await runner.runAgentTurnPrepare(
      {
        prompt: "continue",
        messages: [],
        queuedInjections: [],
      },
      { sessionKey: "agent:main:main" },
    );

    expect(
      [queuedContext.prependContext, queuedContext.appendContext, hookContext?.prependContext]
        .filter(Boolean)
        .join("\n\n"),
    ).toContain("approval workflow resumed");
    expect(hookContext?.prependContext).toBe("fixture turn context");
  });

  it("reports duplicate next-turn injections as not newly enqueued", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-injection-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: {
          session: { store: storePath },
        },
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
            };
            return undefined;
          });
          const now = Date.now();

          const first = await enqueuePluginNextTurnInjection({
            pluginId: "approval-fixture",
            injection: {
              sessionKey: "agent:main:main",
              text: "resume approval workflow",
              placement: "prepend_context",
              idempotencyKey: "approval:resume",
            },
            now,
          });
          const duplicate = await enqueuePluginNextTurnInjection({
            pluginId: "approval-fixture",
            injection: {
              sessionKey: "agent:main:main",
              text: "resume approval workflow again",
              placement: "prepend_context",
              idempotencyKey: "approval:resume",
            },
            now: now + 1,
          });

          expect(first.enqueued).toBe(true);
          expect(duplicate).toEqual({
            enqueued: false,
            id: first.id,
            sessionKey: "agent:main:main",
          });
          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(
            stored["agent:main:main"]?.pluginNextTurnInjections?.["approval-fixture"],
          ).toHaveLength(1);
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

  it("suppresses stale next-turn injections from plugins that are no longer loaded", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "active-injector",
        name: "Active Injector",
        status: "loaded",
      }),
      createPluginRecord({
        id: "disabled-injector",
        name: "Disabled Injector",
        status: "disabled",
      }),
    );
    setActivePluginRegistry(registry);
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-stale-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: {
          session: { store: storePath },
        },
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginNextTurnInjections: {
                "active-injector": [
                  {
                    id: "active",
                    pluginId: "active-injector",
                    text: "active prompt contribution",
                    placement: "append_context",
                    createdAt: 1,
                  },
                ],
                "disabled-injector": [
                  {
                    id: "stale",
                    pluginId: "disabled-injector",
                    text: "stale prompt contribution",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            drainPluginNextTurnInjections({
              sessionKey: "agent:main:main",
              now: 2,
            }),
          ).resolves.toEqual([
            expect.objectContaining({
              id: "active",
              pluginId: "active-injector",
              text: "active prompt contribution",
            }),
          ]);
          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]?.pluginNextTurnInjections).toBeUndefined();
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

  it("preserves global enqueue order when draining live next-turn injections", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "injector-a",
        name: "Injector A",
        status: "loaded",
      }),
      createPluginRecord({
        id: "injector-b",
        name: "Injector B",
        status: "loaded",
      }),
    );
    setActivePluginRegistry(registry);
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-order-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: {
          session: { store: storePath },
        },
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginNextTurnInjections: {
                "injector-a": [
                  {
                    id: "a1",
                    pluginId: "injector-a",
                    text: "first",
                    placement: "append_context",
                    createdAt: 1,
                  },
                  {
                    id: "a2",
                    pluginId: "injector-a",
                    text: "third",
                    placement: "append_context",
                    createdAt: 3,
                  },
                ],
                "injector-b": [
                  {
                    id: "b1",
                    pluginId: "injector-b",
                    text: "second",
                    placement: "append_context",
                    createdAt: 2,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            drainPluginNextTurnInjections({
              sessionKey: "agent:main:main",
              now: 4,
            }),
          ).resolves.toEqual([
            expect.objectContaining({ id: "a1", text: "first" }),
            expect.objectContaining({ id: "b1", text: "second" }),
            expect.objectContaining({ id: "a2", text: "third" }),
          ]);
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

  it("validates gateway protocol envelopes for plugin patch and UI descriptors", () => {
    expect(
      validateSessionsPluginPatchParams({
        key: "agent:main:main",
        pluginId: "approval-plugin",
        namespace: "workflow",
        value: { state: "waiting" },
      }),
    ).toBe(true);
    expect(
      validateSessionsPluginPatchParams({
        key: "agent:main:main",
        pluginId: "approval-plugin",
        namespace: "workflow",
        value: { state: "waiting" },
        accidentalPlanModeRootField: true,
      }),
    ).toBe(false);
    expect(validatePluginsUiDescriptorsParams({})).toBe(true);
    expect(validatePluginsUiDescriptorsParams({ pluginId: "host-hook-fixture" })).toBe(false);
  });

  it("enforces command requiredScopes for gateway clients while preserving text command continuations", async () => {
    const handlerCalls: string[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "approval-command-fixture",
        name: "Approval Command Fixture",
      }),
      register(api) {
        api.registerCommand({
          name: "approval-fixture",
          description: "Continue the agent after approval.",
          requiredScopes: [APPROVALS_SCOPE],
          acceptsArgs: true,
          handler: async (ctx) => {
            handlerCalls.push(ctx.args ?? "");
            return { text: "approval queued", continueAgent: true };
          },
        });
      },
    });
    const registration = registry.registry.commands[0];
    expect(registration).toBeTruthy();
    const command = {
      ...registration.command,
      pluginId: registration.pluginId,
      pluginName: registration.pluginName,
      pluginRoot: registration.rootDir,
    };

    await expect(
      executePluginCommand({
        command,
        args: "resume-text",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume-text",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [READ_SCOPE, WRITE_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({
      text: `⚠️ This command requires gateway scope: ${APPROVALS_SCOPE}.`,
    });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [APPROVALS_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text", "resume"]);
  });

  it("dispatches sanitized agent events and clears plugin run context on run end", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-1", namespace: "lastToolEvent" },
      }),
    ).toEqual({ runId: "run-1", seen: true });

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-1", namespace: "lastToolEvent" },
      }),
    ).toBeUndefined();
  });

  it("continues agent event dispatch and terminal cleanup when one subscription throws", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "throwing-subscription",
        name: "Throwing Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "throws",
          streams: ["tool"],
          handle() {
            throw new Error("subscription failed");
          },
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "healthy-subscription",
        name: "Healthy Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "records",
          streams: ["tool"],
          handle(event, ctx) {
            ctx.setRunContext("seen", { runId: event.runId });
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-throws",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "healthy-subscription",
        get: { runId: "run-throws", namespace: "seen" },
      }),
    ).toEqual({ runId: "run-throws" });

    emitAgentEvent({
      runId: "run-throws",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "healthy-subscription",
        get: { runId: "run-throws", namespace: "seen" },
      }),
    ).toBeUndefined();
  });

  it("covers the non-Plan plugin archetypes promised by the host-hook fixture", () => {
    const archetypes = [
      {
        name: "approval workflow",
        seams: [
          "session extension",
          "command continuation",
          "next-turn injection",
          "UI descriptor",
        ],
      },
      {
        name: "budget/workspace policy gate",
        seams: ["trusted tool policy", "tool metadata", "session projection"],
      },
      {
        name: "background lifecycle monitor",
        seams: ["agent event subscription", "scheduler cleanup", "heartbeat prompt contribution"],
      },
    ];

    expect(archetypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "approval workflow" }),
        expect.objectContaining({ name: "budget/workspace policy gate" }),
        expect.objectContaining({ name: "background lifecycle monitor" }),
      ]),
    );
    expect(archetypes.flatMap((entry) => entry.seams)).toEqual(
      expect.arrayContaining([
        "session extension",
        "trusted tool policy",
        "agent event subscription",
        "scheduler cleanup",
      ]),
    );
  });

  it("proves every #71676 Plan Mode entry-point class has a generic host seam", () => {
    const parityMap = [
      ["session state + sessions.patch", "session extensions + sessions.pluginPatch"],
      [
        "pending injections + approval resumes",
        "durable next-turn injections + agent_turn_prepare",
      ],
      ["mutation gates around tools", "trusted tool policy before before_tool_call"],
      ["slash/native command continuations", "requiredScopes + reserved ownership + continueAgent"],
      ["Control UI mode/cards/status", "Control UI descriptor projection"],
      [
        "plan snapshots, nudges, subagent follow-ups, heartbeat",
        "agent events + run context + scheduler cleanup + heartbeat contribution",
      ],
      ["tool catalog display metadata", "plugin tool metadata projection"],
      ["disable/reset/delete/restart cleanup", "runtime lifecycle cleanup"],
    ];

    expect(parityMap).toHaveLength(8);
    for (const [entryPoint, seam] of parityMap) {
      expect(entryPoint).toBeTruthy();
      expect(seam).toBeTruthy();
      expect(seam).not.toContain("Plan Mode");
    }
  });

  it("cleans plugin-owned session state and lifecycle resources on reset/disable", async () => {
    const cleanupEvents: string[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "cleanup-fixture",
        name: "Cleanup Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "cleanup test",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`session:${reason}:${sessionKey ?? ""}`);
          },
        });
        api.registerRuntimeLifecycle({
          id: "monitor",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`runtime:${reason}:${sessionKey ?? ""}`);
          },
        });
        api.registerSessionSchedulerJob({
          id: "nudge",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`scheduler:${reason}:${sessionKey}`);
          },
        });
      },
    });

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "cleanup-fixture": { workflow: { state: "waiting" } },
        "other-plugin": { workflow: { state: "keep" } },
      },
      pluginNextTurnInjections: {
        "cleanup-fixture": [
          {
            id: "resume",
            pluginId: "cleanup-fixture",
            text: "resume",
            placement: "prepend_context" as const,
            createdAt: 1,
          },
        ],
        "other-plugin": [
          {
            id: "keep",
            pluginId: "other-plugin",
            text: "keep",
            placement: "append_context" as const,
            createdAt: 1,
          },
        ],
      },
    };
    clearPluginOwnedSessionState(entry, "cleanup-fixture");
    expect(entry.pluginExtensions).toEqual({
      "other-plugin": { workflow: { state: "keep" } },
    });
    expect(entry.pluginNextTurnInjections).toEqual({
      "other-plugin": [
        {
          id: "keep",
          pluginId: "other-plugin",
          text: "keep",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-state-"),
    );
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: {
          session: { store: path.join(stateDir, "sessions.json") },
        },
        run: async () => {
          await runPluginHostCleanup({
            registry: registry.registry,
            pluginId: "cleanup-fixture",
            reason: "reset",
            sessionKey: "agent:main:main",
          });
          await cleanupReplacedPluginHostRegistry({
            previousRegistry: registry.registry,
            nextRegistry: createEmptyPluginRegistry(),
          });
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

    expect(cleanupEvents).toEqual([
      "session:reset:agent:main:main",
      "runtime:reset:agent:main:main",
      "scheduler:reset:agent:main:main",
      "session:disable:",
      "runtime:disable:",
    ]);
    expect(listPluginSessionSchedulerJobs("cleanup-fixture")).toEqual([]);
  });

  it("keeps scheduler job records when cleanup fails so cleanup can retry", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "cleanup-failure-fixture",
        name: "Cleanup Failure Fixture",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "retryable-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: () => {
            throw new Error("cleanup failed");
          },
        });
      },
    });

    await expect(
      runPluginHostCleanup({
        registry: registry.registry,
        pluginId: "cleanup-failure-fixture",
        reason: "disable",
      }),
    ).resolves.toMatchObject({
      failures: [
        expect.objectContaining({
          pluginId: "cleanup-failure-fixture",
          hookId: "scheduler:retryable-job",
        }),
      ],
    });
    expect(listPluginSessionSchedulerJobs("cleanup-failure-fixture")).toEqual([
      {
        id: "retryable-job",
        pluginId: "cleanup-failure-fixture",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
  });

  it("preserves restarted scheduler jobs while cleaning the replaced registry", async () => {
    const cleanupEvents: string[] = [];
    const previous = createEmptyPluginRegistry();
    previous.plugins.push(
      createPluginRecord({
        id: "restart-fixture",
        name: "Restart Fixture",
        status: "loaded",
      }),
    );
    previous.sessionSchedulerJobs = [
      {
        pluginId: "restart-fixture",
        pluginName: "Restart Fixture",
        job: {
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: ({ reason, jobId }) => {
            cleanupEvents.push(`${reason}:${jobId}`);
          },
        },
        source: "/virtual/restart-fixture/index.ts",
        rootDir: "/virtual/restart-fixture",
      },
    ];
    const next = createEmptyPluginRegistry();
    next.plugins.push(
      createPluginRecord({
        id: "restart-fixture",
        name: "Restart Fixture",
        status: "loaded",
      }),
    );
    next.sessionSchedulerJobs = [
      {
        pluginId: "restart-fixture",
        pluginName: "Restart Fixture",
        job: {
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: () => undefined,
        },
        source: "/virtual/restart-fixture/index.ts",
        rootDir: "/virtual/restart-fixture",
      },
    ];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "restart-fixture",
        name: "Restart Fixture",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        });
      },
    });

    await expect(
      cleanupReplacedPluginHostRegistry({
        previousRegistry: previous,
        nextRegistry: next,
      }),
    ).resolves.toMatchObject({ failures: [] });
    expect(cleanupEvents).toEqual([]);
    expect(listPluginSessionSchedulerJobs("restart-fixture")).toEqual([
      {
        id: "shared-job",
        pluginId: "restart-fixture",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
  });

  it("does not register scheduler jobs globally during non-activating registry loads", () => {
    const registry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const config = {};
    let handle:
      | {
          id: string;
          pluginId: string;
          sessionKey: string;
          kind: string;
        }
      | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "snapshot-fixture",
        name: "Snapshot Fixture",
      }),
      register(api) {
        handle = api.registerSessionSchedulerJob({
          id: "snapshot-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        });
      },
    });

    expect(handle).toEqual({
      id: "snapshot-job",
      pluginId: "snapshot-fixture",
      sessionKey: "agent:main:main",
      kind: "monitor",
    });
    expect(registry.registry.sessionSchedulerJobs).toEqual([
      expect.objectContaining({
        pluginId: "snapshot-fixture",
        job: expect.objectContaining({
          id: "snapshot-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        }),
      }),
    ]);
    expect(listPluginSessionSchedulerJobs("snapshot-fixture")).toEqual([]);
  });

  it("removes persistent plugin-owned session state and pending injections during cleanup", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "cleanup-fixture",
        name: "Cleanup Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "cleanup test",
        });
      },
    });

    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-store-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: {
          session: { store: storePath },
        },
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginExtensions: {
                "cleanup-fixture": { workflow: { state: "waiting" } },
                "other-plugin": { workflow: { state: "keep" } },
              },
              pluginNextTurnInjections: {
                "cleanup-fixture": [
                  {
                    id: "resume",
                    pluginId: "cleanup-fixture",
                    text: "resume",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
                "other-plugin": [
                  {
                    id: "keep",
                    pluginId: "other-plugin",
                    text: "keep",
                    placement: "append_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            runPluginHostCleanup({
              registry: registry.registry,
              pluginId: "cleanup-fixture",
              reason: "disable",
            }),
          ).resolves.toMatchObject({ failures: [] });

          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]).toEqual(
            expect.objectContaining({
              pluginExtensions: {
                "other-plugin": { workflow: { state: "keep" } },
              },
              pluginNextTurnInjections: {
                "other-plugin": [
                  {
                    id: "keep",
                    pluginId: "other-plugin",
                    text: "keep",
                    placement: "append_context",
                    createdAt: 1,
                  },
                ],
              },
            }),
          );
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

  it("cleans pending injections for plugins that registered no host-hook callbacks", async () => {
    const previousRegistry = createEmptyPluginRegistry();
    previousRegistry.plugins.push(
      createPluginRecord({
        id: "injection-only-fixture",
        name: "Injection Only Fixture",
        status: "loaded",
      }),
    );
    const stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-hooks-injection-only-"),
    );
    const storePath = path.join(stateDir, "sessions.json");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await withTempConfig({
        cfg: {
          session: { store: storePath },
        },
        run: async () => {
          await updateSessionStore(storePath, (store) => {
            store["agent:main:main"] = {
              sessionId: "session-1",
              updatedAt: Date.now(),
              pluginNextTurnInjections: {
                "injection-only-fixture": [
                  {
                    id: "resume",
                    pluginId: "injection-only-fixture",
                    text: "resume",
                    placement: "prepend_context",
                    createdAt: 1,
                  },
                ],
              },
            };
            return undefined;
          });

          await expect(
            cleanupReplacedPluginHostRegistry({
              previousRegistry,
              nextRegistry: createEmptyPluginRegistry(),
            }),
          ).resolves.toMatchObject({ failures: [] });

          const stored = loadSessionStore(storePath, { skipCache: true });
          expect(stored["agent:main:main"]?.pluginNextTurnInjections).toBeUndefined();
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
