import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { createAgentToolsSandboxContext } from "../agents/test-helpers/agent-tools-sandbox-context.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { ToolAllowDenyPolicyConfig } from "../config/types.tools.js";
import {
  drainSessionToolsFixture,
  TARGET,
  withSessionToolsFixture,
  sessionToolsEntry,
  sessionToolsTranscript,
  seedSessionToolsEntry,
} from "./local-request-context.session-tools.test-support.js";
import { roleClient } from "./session-sharing.test-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// mock-isolation: Session routing uses no plugin tools and must not load ambient plugin state.
vi.mock("../agents/openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
  resolveOpenClawPluginToolsForOptionsAsync: async () => [],
}));

afterEach(drainSessionToolsFixture);

describe("guest session rename through the agent catalog", () => {
  beforeAll(async () => {
    await import("./server-methods/sessions-mutations.js");
  });
  it("renames only the creator's session without changing its running work or settings", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const profileId = roleClient("view", "rename-guest").authenticatedUserProfile!.profileId;
      cfg.gateway!.roles!.definitions.view!.scopes = ["operator.sessions.write"];
      const sessionKey = "agent:main:dashboard:guest-rename";
      const scope = { agentId: "main", sessionKey };
      const original = {
        sessionId: "guest-rename-session",
        updatedAt: 1,
        visibility: "shared" as const,
        createdVia: "operator" as const,
        label: "Research notes",
        createdActor: { type: "human", source: "profile", id: profileId } as const,
        permissionMode: "workspace" as const,
        modelOverride: "model-a",
      };
      await upsertSessionEntryCore(scope, original);
      await appendTranscriptMessage(
        { ...scope, sessionId: original.sessionId },
        { message: { role: "user", content: "Keep researching while renaming this session." } },
      );
      const history = await sessionToolsTranscript(sessionKey, original.sessionId);
      const beforeRename = sessionToolsEntry(sessionKey)!;
      const controller = new AbortController();
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.sessions.write"],
        signal: controller.signal,
        readCurrentRoleFacts: () => ({ assignedRole: "view" }),
        assertCurrent: () => {},
      });
      await withPersonalToolTurn(
        {
          owner: { profileId, senderId: "guest", name: "Guest", operatorAuthority },
          sessionKey,
          sessionId: original.sessionId,
        },
        async ({ operation }) => {
          const options = {
            config: { ...cfg, tools: { ...cfg.tools, allow: ["sessions"] } },
            sessionKey,
            sessionId: original.sessionId,
            senderIsOwner: false,
            messageProvider: "webchat",
          };
          const tool = expectDefined(
            createOpenClawCodingTools(options).find((candidate) => candidate.name === "sessions"),
            "sessions tool unavailable",
          );
          const result = await tool.execute("rename", { action: "patch", label: "Research plan" });
          expect(result.details).toMatchObject({
            status: "updated",
            sessionKey,
            updated: ["label"],
          });
          const { updatedAt: _beforeTime, ...before } = beforeRename;
          const { updatedAt: _afterTime, ...after } = sessionToolsEntry(sessionKey)!;
          expect(after).toEqual({ ...before, label: "Research plan" });
          expect(await sessionToolsTranscript(sessionKey, original.sessionId)).toEqual(history);
          expect(operation.abortSignal.aborted).toBe(false);
          for (const [args, error] of [
            [
              {
                action: "patch",
                label: "Foreign",
                sessionKey: TARGET,
                expectedSessionId: "session-tools-target-id",
              },
              "Session-scoped writes require your own session",
            ],
            [
              { action: "patch", label: "Stale", expectedSessionId: "replaced-session" },
              "current durable session identity",
            ],
            [
              { action: "patch", label: "Broader", model: "model-b" },
              "current operator write grant",
            ],
            [{ action: "patch", archived: true }, "current operator write grant"],
          ] as const) {
            await expect(tool.execute("denied", args)).rejects.toThrow(error);
          }
          expect(sessionToolsEntry(sessionKey)?.label).toBe("Research plan");
          expect(sessionToolsEntry(TARGET)?.label).toBeUndefined();
          const denied = createOpenClawCodingTools({
            ...options,
            config: { ...options.config, tools: { ...options.config.tools, deny: ["sessions"] } },
          });
          expect(denied.some((candidate) => candidate.name === "sessions")).toBe(false);
          await upsertSessionEntryCore(scope, {
            ...sessionToolsEntry(sessionKey)!,
            sessionId: "replacement-session",
          });
          expect(sessionToolsEntry(sessionKey)?.sessionId).toBe("replacement-session");
          await expect(
            tool.execute("replaced", { action: "patch", label: "Stale run rename" }),
          ).rejects.toMatchObject({ details: { reason: "session-changed" } });
          await expect(
            tool.execute("replacement-id", {
              action: "patch",
              label: "Retarget",
              expectedSessionId: "replacement-session",
            }),
          ).rejects.toThrow("current durable session identity");
          controller.abort(new Error("guest access revoked"));
          await expect(
            tool.execute("revoked", { action: "patch", label: "Revoked rename" }),
          ).rejects.toThrow("guest access revoked");
          expect(sessionToolsEntry(sessionKey)?.label).toBe("Research plan");
        },
      );
    });
  });

  it("keeps sandbox rename scoped across catalogs and explicit operator policies", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const profileId = roleClient("view", "sandbox-rename-guest").authenticatedUserProfile!
        .profileId;
      cfg.gateway!.roles!.definitions.view!.sandbox = "required";
      const sessionKey = "agent:main:dashboard:sandbox-rename";
      const sessionId = "sandbox-rename-session";
      await seedSessionToolsEntry(sessionKey, sessionId, {
        sandbox: "required",
        visibility: "shared",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: profileId },
      });
      const options = {
        config: cfg,
        sessionKey,
        sessionId,
        senderIsOwner: false,
        messageProvider: "webchat",
      };
      const sandboxConfig = resolveSandboxConfigForAgent(cfg, "main");
      const defaultsWithoutAdmission = resolveConversationCapabilityProfile({
        ...options,
        sandboxToolPolicy: sandboxConfig.tools,
      });
      // Generic allow/addition/glob precedence and default-policy provenance are covered
      // by sandbox/tool-policy.test.ts and tools/sessions-create-tool.test.ts.
      const scenarios: [
        string,
        ToolAllowDenyPolicyConfig | undefined,
        "rename" | "full" | "denied" | "absent",
      ][] = [
        ["operator.sessions.write", undefined, "rename"],
        ["operator.write", { allow: ["sessions"] }, "full"],
        ["operator.read", { allow: ["sessions"] }, "denied"],
        ["operator.sessions.write", { deny: ["sessions"] }, "absent"],
      ];
      for (const [scope, policy, mode] of scenarios) {
        cfg.gateway!.roles!.definitions.view!.scopes = [scope];
        const operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId,
          scopes: [scope],
          signal: new AbortController().signal,
          readCurrentRoleFacts: () => ({ assignedRole: "view" }),
          assertCurrent: () => {},
        });
        await withPersonalToolTurn(
          {
            owner: { profileId, senderId: "sandbox-guest", name: "Guest", operatorAuthority },
            sessionKey,
            sessionId,
          },
          async ({ admittedRunContext }) => {
            const config = { ...cfg, tools: { ...cfg.tools, sandbox: { tools: policy } } };
            const scopedOptions = { ...options, config };
            const resolveLoopback = (admitted = true) =>
              resolveGatewayScopedTools({
                ...scopedOptions,
                cfg: config,
                surface: "loopback",
                admittedRunContext: admitted ? admittedRunContext : undefined,
              });
            const loopback = (await resolveLoopback()).tools;
            if (mode === "absent") {
              expect(loopback.some((tool) => tool.name === "sessions")).toBe(false);
              return;
            }
            const sandbox = resolveSandboxConfigForAgent(config, "main");
            const nativeOptions = {
              ...scopedOptions,
              toolConstructionPlan: {
                includeBaseCodingTools: false,
                includeShellTools: false,
                includeChannelTools: false,
                includeOpenClawTools: true,
                includePluginTools: false,
              },
              sandbox: {
                ...createAgentToolsSandboxContext({
                  workspaceDir: cfg.agents!.entries!.main!.workspace!,
                  workspaceAccess: "none",
                  sessionKey,
                  containerName: "rename-test",
                  tools: sandbox.tools,
                  dockerOverrides: sandbox.docker,
                }),
                required: true as const,
                backendId: sandbox.backend,
              },
            };
            const catalogs =
              mode === "rename"
                ? [
                    createOpenClawCodingTools(nativeOptions),
                    createOpenClawCodingTools({
                      ...nativeOptions,
                      conversationCapabilityProfile: resolveConversationCapabilityProfile({
                        ...scopedOptions,
                        sandboxToolPolicy: sandbox.tools,
                      }),
                    }),
                    loopback,
                  ]
                : [loopback];
            for (const [index, tools] of catalogs.entries()) {
              const tool = expectDefined(
                tools.find((candidate) => candidate.name === "sessions"),
                "sessions",
              );
              if (mode === "denied") {
                await expect(
                  tool.execute("denied", { action: "patch", label: "Read only" }),
                ).rejects.toThrow("Only assign_owner is available to non-owner callers");
                continue;
              }
              if (mode === "rename") {
                for (const args of [
                  { action: "assign_owner", ownerType: "human", ownerId: profileId },
                  { action: "patch", archived: true },
                  { action: "patch", label: "Broader", model: "model-b" },
                  { action: "stop" },
                  { action: "patch", targets: [{ sessionKey }], label: "Batch" },
                ]) {
                  await expect(tool.execute("denied", args)).rejects.toThrow(
                    "only permits renaming",
                  );
                }
              } else {
                expect(tool.parameters).toHaveProperty("properties.archived");
              }
              const label = `${scope} ${index}`;
              const args: Record<string, unknown> = { action: "patch", label };
              if (mode === "rename" && index === 0) {
                delete args.label;
                Object.setPrototypeOf(args, {
                  label,
                  icon: "book",
                  targets: [{ sessionKey: TARGET, expectedSessionId: "session-tools-target-id" }],
                });
              }
              expect((await tool.execute("rename", args)).details).toMatchObject({
                status: "updated",
                updated: ["label"],
              });
              expect(sessionToolsEntry(sessionKey)).toMatchObject({ label });
              expect(sessionToolsEntry(sessionKey)?.icon).toBeUndefined();
              expect(sessionToolsEntry(TARGET)?.label).toBeUndefined();
            }
            if (mode === "rename") {
              const absent = (tools: ReturnType<typeof createOpenClawCodingTools>) =>
                expect(tools.some((tool) => tool.name === "sessions")).toBe(false);
              absent((await resolveLoopback(false)).tools);
              absent(createOpenClawCodingTools({ ...nativeOptions, senderIsOwner: true }));
              absent(
                createOpenClawCodingTools({
                  ...nativeOptions,
                  conversationCapabilityProfile: defaultsWithoutAdmission,
                }),
              );
            }
          },
        );
      }
    });
  });
});
