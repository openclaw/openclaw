import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { clearPluginHostRuntimeState } from "../host-hook-runtime.js";
import { patchPluginSessionExtension } from "../host-hook-state.js";
import {
  buildPluginSchedulerCronName,
  resolveAttachmentDelivery,
  schedulePluginSessionTurn,
  sendPluginSessionAttachment,
  unschedulePluginSessionTurnsByTag,
} from "../host-hook-workflow.js";
import type { PluginControlUiDescriptor, PluginJsonValue } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

// Hoisted mocks for the gateway/cron call surface and outbound message path so
// scheduler/attachment seams can be exercised against deterministic fakes.
const workflowMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: workflowMocks.callGatewayTool,
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: workflowMocks.sendMessage,
}));

describe("plugin SDK follow-up seams (B-F)", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    workflowMocks.callGatewayTool.mockReset();
    workflowMocks.sendMessage.mockReset();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
  });

  // -------------------------------------------------------------------------
  // Seam B — channel-typed attachment hints
  // -------------------------------------------------------------------------

  describe("Seam B: resolveAttachmentDelivery channel hint precedence", () => {
    it("prefers channelHints.telegram.parseMode over captionFormat", () => {
      expect(
        resolveAttachmentDelivery({
          channel: "telegram",
          captionFormat: "html",
          channelHints: { telegram: { parseMode: "MarkdownV2" } },
        }),
      ).toEqual({ parseMode: "MarkdownV2" });
    });

    it("maps captionFormat to telegram parseMode when no hint is given", () => {
      expect(resolveAttachmentDelivery({ channel: "telegram", captionFormat: "html" })).toEqual({
        parseMode: "HTML",
      });
      expect(
        resolveAttachmentDelivery({ channel: "telegram", captionFormat: "markdownv2" }),
      ).toEqual({ parseMode: "MarkdownV2" });
      expect(resolveAttachmentDelivery({ channel: "telegram", captionFormat: "plain" })).toEqual(
        {},
      );
    });

    it("forwards telegram disableNotification + forceDocumentMime hints", () => {
      expect(
        resolveAttachmentDelivery({
          channel: "telegram",
          channelHints: {
            telegram: { disableNotification: true, forceDocumentMime: "application/pdf" },
          },
        }),
      ).toEqual({
        disableNotification: true,
        forceDocumentMime: "application/pdf",
      });
    });

    it("forwards discord ephemeral + suppressEmbeds hints, ignores telegram-only fields", () => {
      expect(
        resolveAttachmentDelivery({
          channel: "discord",
          channelHints: {
            discord: { ephemeral: true, suppressEmbeds: false },
            telegram: { disableNotification: true },
          },
        }),
      ).toEqual({ ephemeral: true, suppressEmbeds: false });
    });

    it("forwards slack threadTs + unfurlLinks hints", () => {
      expect(
        resolveAttachmentDelivery({
          channel: "slack",
          channelHints: { slack: { unfurlLinks: false, threadTs: "1700000000.000100" } },
        }),
      ).toEqual({ unfurlLinks: false, threadTs: "1700000000.000100" });
    });

    it("returns an empty object for unknown channels even when hints are present", () => {
      expect(
        resolveAttachmentDelivery({
          channel: "unknown",
          channelHints: { telegram: { parseMode: "HTML" } },
        }),
      ).toEqual({});
    });

    it("plumbs Telegram parseMode and silent hints through sendPluginSessionAttachment", async () => {
      // Materialise a session store with a real telegram delivery context so
      // sendPluginSessionAttachment can resolve a route. The mocked
      // sendMessage records the resolved delivery hints for the assertion.
      const stateDir = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-channel-hints-"),
      );
      const storePath = path.join(stateDir, "sessions.json");
      const filePath = path.join(stateDir, "x.txt");
      await fs.writeFile(filePath, "x", "utf8");
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      try {
        await withTempConfig({
          cfg: { session: { store: storePath } },
          run: async () => {
            await updateSessionStore(storePath, (store) => {
              store["agent:main:main"] = {
                sessionId: "session-id",
                updatedAt: Date.now(),
                deliveryContext: {
                  channel: "telegram",
                  to: "12345",
                  accountId: "default",
                },
              } as unknown as SessionEntry;
            });
            workflowMocks.sendMessage.mockImplementation(
              async (params: Record<string, unknown>) => ({
                channel: params.channel,
                to: params.to,
                via: "direct" as const,
                mediaUrl: null,
                silent: params.silent,
              }),
            );
            const result = await sendPluginSessionAttachment({
              origin: "bundled",
              sessionKey: "agent:main:main",
              files: [{ path: filePath }],
              channelHints: { telegram: { disableNotification: true, parseMode: "HTML" } },
            });
            expect(result.ok).toBe(true);
            expect(workflowMocks.sendMessage).toHaveBeenCalledTimes(1);
            const call = workflowMocks.sendMessage.mock.calls[0]?.[0] as Record<string, unknown>;
            expect(call.silent).toBe(true);
            expect(call.parseMode).toBe("HTML");
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

  // -------------------------------------------------------------------------
  // Seam C — suppressHostInputWhile descriptor field (declarative)
  // -------------------------------------------------------------------------

  describe("Seam C: suppressHostInputWhile descriptor", () => {
    it("accepts the new declarative field on PluginControlUiDescriptor", () => {
      // The shape is purely declarative — UI clients consume it. The contract
      // here is that the type compiles + is preserved by structuredClone, so a
      // round-trip through JSON serialisation never silently strips it.
      const descriptor: PluginControlUiDescriptor = {
        id: "approval-card",
        surface: "session",
        label: "Approval",
        renderer: "approval-card",
        suppressHostInputWhile: {
          stateNamespace: "workflow",
          predicateField: "approval.pending",
          equalsSessionKey: true,
          requireHandlerActionId: "approve",
        },
      };
      const cloned = structuredClone(descriptor);
      expect(cloned.suppressHostInputWhile).toEqual({
        stateNamespace: "workflow",
        predicateField: "approval.pending",
        equalsSessionKey: true,
        requireHandlerActionId: "approve",
      });
    });

    it("persists suppressHostInputWhile through control UI descriptor registration", () => {
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id: "approval-ui", name: "Approval UI" }),
        register(api) {
          api.registerControlUiDescriptor({
            id: "approval-card",
            surface: "session",
            label: "Approval",
            renderer: "approval-card",
            suppressHostInputWhile: {
              stateNamespace: "workflow",
              predicateField: "approval.pending",
              equalsSessionKey: true,
              requireHandlerActionId: "approve",
            },
          });
        },
      });

      expect(
        registry.registry.controlUiDescriptors?.[0]?.descriptor.suppressHostInputWhile,
      ).toEqual({
        stateNamespace: "workflow",
        predicateField: "approval.pending",
        equalsSessionKey: true,
        requireHandlerActionId: "approve",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Seam D — scheduler taxonomy + tagged cleanup
  // -------------------------------------------------------------------------

  describe("Seam D: scheduler tags + payloadExtras + tag-based cleanup", () => {
    it("auto-prefixes the cron job name with the plugin id and tag", () => {
      expect(
        buildPluginSchedulerCronName({
          pluginId: "workflow-plugin",
          sessionKey: "agent:main:main",
          tag: "nudge",
          uniqueId: "abc",
        }),
      ).toBe("plugin:workflow-plugin:tag:nudge:agent:main:main:abc");
    });

    it("falls back to a non-tagged name when no tag is supplied", () => {
      expect(
        buildPluginSchedulerCronName({
          pluginId: "workflow-plugin",
          sessionKey: "agent:main:main",
          uniqueId: "xyz",
        }),
      ).toBe("plugin:workflow-plugin:agent:main:main:xyz");
    });

    it("keeps the plugin/tag prefix when an explicit name is supplied with a tag", async () => {
      workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
        if (method === "cron.add") {
          return { payload: { jobId: "job-named-tagged" } };
        }
        return { ok: true };
      });

      const handle = await schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
          tag: "followup",
          name: "custom-nudge-name",
        },
      });

      expect(handle?.id).toBe("job-named-tagged");
      const addCall = workflowMocks.callGatewayTool.mock.calls.find(
        (args) => args[0] === "cron.add",
      );
      const job = addCall?.[2] as Record<string, unknown>;
      expect(job.name).toBe(
        "plugin:workflow-plugin:tag:followup:agent:main:main:custom-nudge-name",
      );
    });

    it("merges payloadExtras into the cron payload and persists the tagged name", async () => {
      workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
        if (method === "cron.add") {
          return { payload: { jobId: "job-tagged" } };
        }
        return { ok: true };
      });
      const handle = await schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
          tag: "nudge",
          payloadExtras: { archetype: "approval-snapshot", version: 2 },
        },
      });
      expect(handle?.id).toBe("job-tagged");
      const calls = workflowMocks.callGatewayTool.mock.calls;
      const addCall = calls.find((args) => args[0] === "cron.add");
      expect(addCall).toBeDefined();
      const job = addCall?.[2] as Record<string, unknown>;
      expect(job.name).toMatch(/^plugin:workflow-plugin:tag:nudge:agent:main:main:/);
      const payload = job.payload as Record<string, unknown>;
      expect(payload.kind).toBe("agentTurn");
      expect(payload.message).toBe("wake");
      expect(payload.archetype).toBe("approval-snapshot");
      expect(payload.version).toBe(2);
    });

    it("listing-then-removing by tag only touches matching jobs in the same session", async () => {
      const removed: string[] = [];
      workflowMocks.callGatewayTool.mockImplementation(
        async (method: string, _opts: unknown, body: unknown) => {
          if (method === "cron.list") {
            return {
              jobs: [
                {
                  id: "job-a",
                  name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
                  sessionTarget: "session:agent:main:main",
                },
                {
                  id: "job-b",
                  name: "plugin:workflow-plugin:tag:nudge:agent:main:main:2",
                  sessionTarget: "session:agent:main:main",
                },
                {
                  id: "job-c",
                  // Different plugin id under the same tag - must not match.
                  name: "plugin:other-plugin:tag:nudge:agent:main:main:1",
                  sessionTarget: "session:agent:main:main",
                },
                {
                  id: "job-d",
                  // Same plugin + tag but different session - must not match.
                  name: "plugin:workflow-plugin:tag:nudge:agent:other:main:1",
                  sessionTarget: "session:agent:other:main",
                },
              ],
            };
          }
          if (method === "cron.remove") {
            removed.push((body as { id?: string }).id ?? "");
            return { removed: true };
          }
          return undefined;
        },
      );
      const result = await unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      });
      expect(result).toEqual({ removed: 2, failed: 0 });
      expect(removed.toSorted()).toEqual(["job-a", "job-b"]);
    });

    it("returns a no-op result for non-bundled origins", async () => {
      const result = await unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "workspace",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      });
      expect(result).toEqual({ removed: 0, failed: 0 });
      expect(workflowMocks.callGatewayTool).not.toHaveBeenCalled();
    });

    it("counts a list failure as `failed: 1` and no removals", async () => {
      workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
        if (method === "cron.list") {
          throw new Error("cron list down");
        }
        return undefined;
      });
      const result = await unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      });
      expect(result).toEqual({ removed: 0, failed: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Seam E — session extension promotion to SessionEntry slot
  // -------------------------------------------------------------------------

  describe("Seam E: session-extension slot promotion", () => {
    it("mirrors the projected value to SessionEntry[slotKey] on every patch and clears it on unset", async () => {
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
              (afterPatch["agent:main:main"] as unknown as Record<string, unknown>)
                .approvalSnapshot,
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
              (afterUnset["agent:main:main"] as unknown as Record<string, unknown>)
                .approvalSnapshot,
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
        },
      });

      expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
      expect(registry.registry.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: "slot-collision",
            message: "sessionEntrySlotKey is reserved by SessionEntry: updatedAt",
          }),
        ]),
      );
    });

    it("does not touch SessionEntry top-level slots when sessionEntrySlotKey is omitted", async () => {
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
            // Verify no extra top-level slot was added.
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

  // Seam F (telegram api re-export) is exercised in
  // `extensions/telegram/api.test.ts` because the extensions package is
  // outside the core src/ test scope and cannot be imported from here.
});
