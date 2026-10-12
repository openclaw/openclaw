import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { ToolAllowDenyPolicyConfig } from "../config/types.tools.js";
import {
  drainSessionToolsFixture,
  TARGET,
  withSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { roleClient } from "./session-sharing.test-utils.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

vi.mock("../agents/openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
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
      const history = await loadTranscriptEvents({ ...scope, sessionId: original.sessionId });
      const beforeRename = loadSessionEntry(scope)!;
      expect(beforeRename.createdActor).toEqual(original.createdActor);
      const controller = new AbortController();
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.sessions.write"],
        signal: controller.signal,
        readCurrentRoleAssignment: () => "view",
        assertCurrent: () => {},
      });
      await withPersonalToolTurn(
        {
          owner: { profileId, senderId: "guest", name: "Guest", operatorAuthority },
          sessionKey,
          sessionId: original.sessionId,
        },
        async ({ operation, admittedRunContext }) => {
          const options = {
            config: { ...cfg, tools: { ...cfg.tools, allow: ["sessions"] } },
            sessionKey,
            sessionId: original.sessionId,
            senderIsOwner: false,
            messageProvider: "webchat",
          };
          const tools = createOpenClawCodingTools(options);
          const tool = tools.find((candidate) => candidate.name === "sessions");
          expect(tool, "guest catalog includes the permitted session operation").toBeDefined();
          if (!tool) {
            throw new Error("sessions tool unavailable");
          }
          expect(tool.parameters).toHaveProperty("properties.label");
          expect(tool.parameters).not.toHaveProperty("properties.model");
          expect(tool.parameters).not.toHaveProperty("properties.archived");
          const loopback = (
            await resolveGatewayScopedTools({
              ...options,
              cfg: options.config,
              surface: "loopback",
              admittedRunContext,
            })
          ).tools.find((candidate) => candidate.name === "sessions");
          expect(loopback?.parameters).toHaveProperty("properties.label");
          const result = await tool.execute("rename", { action: "patch", label: "Research plan" });
          expect(result.details).toMatchObject({
            status: "updated",
            sessionKey,
            updated: ["label"],
          });
          const { updatedAt: _beforeTime, ...before } = beforeRename;
          const { updatedAt: _afterTime, ...after } = loadSessionEntry(scope)!;
          expect(after).toEqual({ ...before, label: "Research plan" });
          expect(await loadTranscriptEvents({ ...scope, sessionId: original.sessionId })).toEqual(
            history,
          );
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
          expect(loadSessionEntry(scope)?.label).toBe("Research plan");
          expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.label).toBeUndefined();
          const denied = createOpenClawCodingTools({
            ...options,
            config: { ...options.config, tools: { ...options.config.tools, deny: ["sessions"] } },
          });
          expect(denied.some((candidate) => candidate.name === "sessions")).toBe(false);
          await upsertSessionEntryCore(scope, {
            ...loadSessionEntry(scope)!,
            sessionId: "replacement-session",
          });
          expect(loadSessionEntry(scope)?.sessionId).toBe("replacement-session");
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
          ).rejects.toThrow("Guest's access changed; ask them again");
          expect(loadSessionEntry(scope)?.label).toBe("Research plan");
        },
      );
    });
  });

  it("respects required-sandbox default and explicit tool policy", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const profileId = roleClient("view", "sandbox-rename-guest").authenticatedUserProfile!
        .profileId;
      cfg.gateway!.roles!.definitions.view!.sandbox = "required";
      const sessionKey = "agent:main:dashboard:sandbox-rename";
      const sessionId = "sandbox-rename-session";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          sandbox: "required",
          visibility: "shared",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: profileId },
        },
      );
      const defaultsWithoutAdmission = resolveConversationCapabilityProfile({
        config: cfg,
        sessionKey,
        sessionId,
        senderIsOwner: false,
        sandboxToolPolicy: resolveSandboxConfigForAgent(cfg, "main").tools,
      });
      for (const scope of ["operator.sessions.write", "operator.write", "operator.read"] as const) {
        const scopes = [scope];
        cfg.gateway!.roles!.definitions.view!.scopes = scopes;
        const canRename = scopes[0] !== "operator.read";
        const operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId,
          scopes,
          signal: new AbortController().signal,
          readCurrentRoleAssignment: () => "view",
          assertCurrent: () => {},
        });
        await withPersonalToolTurn(
          {
            owner: { profileId, senderId: "sandbox-guest", name: "Guest", operatorAuthority },
            sessionKey,
            sessionId,
          },
          async ({ admittedRunContext }) => {
            const policies: Array<
              [string, ToolAllowDenyPolicyConfig | undefined, boolean, boolean]
            > = [
              ["explicit addition", { alsoAllow: ["sessions"] }, true, false],
              ["explicit allow", { allow: ["sessions"] }, true, false],
              ["allow all", { allow: [] }, true, false],
              ["restrictive allow", { allow: ["read"] }, false, false],
              ["explicit deny", { alsoAllow: ["sessions"], deny: ["sessions"] }, false, false],
              ["wildcard deny", { deny: ["sessions*"] }, false, false],
              ["unrelated addition", { alsoAllow: ["read"] }, canRename, true],
              ["default", undefined, canRename, true],
            ];
            for (const [name, policy, available, renameOnly] of policies) {
              const config = {
                ...cfg,
                tools: { ...cfg.tools, sandbox: { tools: policy } },
              };
              const options = {
                config,
                sessionKey,
                sessionId,
                senderIsOwner: false,
                messageProvider: "webchat",
              };
              const sandboxConfig = resolveSandboxConfigForAgent(config, "main");
              const workspaceDir = cfg.agents!.entries!.main!.workspace!;
              const nativeOptions = {
                ...options,
                // This catalog proof does not invoke filesystem or shell tools.
                toolConstructionPlan: {
                  includeBaseCodingTools: false,
                  includeShellTools: false,
                  includeChannelTools: false,
                  includeOpenClawTools: true,
                  includePluginTools: false,
                },
                sandbox: {
                  enabled: true,
                  required: true as const,
                  backendId: sandboxConfig.backend,
                  sessionKey,
                  workspaceDir,
                  agentWorkspaceDir: workspaceDir,
                  workspaceAccess: "none" as const,
                  runtimeId: "rename-test",
                  runtimeLabel: "rename-test",
                  containerName: "rename-test",
                  containerWorkdir: "/workspace",
                  docker: sandboxConfig.docker,
                  tools: sandboxConfig.tools,
                  browserAllowHostControl: false,
                },
              };
              const preparedProfile = resolveConversationCapabilityProfile({
                ...options,
                sandboxToolPolicy: sandboxConfig.tools,
              });
              const catalogs = [
                ["native", createOpenClawCodingTools(nativeOptions)],
                [
                  "prepared native",
                  createOpenClawCodingTools({
                    ...nativeOptions,
                    conversationCapabilityProfile: preparedProfile,
                  }),
                ],
                [
                  "loopback",
                  (
                    await resolveGatewayScopedTools({
                      ...options,
                      cfg: config,
                      surface: "loopback",
                      admittedRunContext,
                    })
                  ).tools,
                ],
              ] as const;
              for (const [surface, tools] of catalogs) {
                const tool = tools.find((candidate) => candidate.name === "sessions");
                expect(Boolean(tool), `${scopes[0]} ${name}: ${surface} discovery`).toBe(available);
                if (!tool) {
                  continue;
                }
                if (!canRename) {
                  expect(tool.parameters).not.toHaveProperty("properties.label");
                  continue;
                }
                expect(tool.parameters).toHaveProperty("properties.label");
                if (renameOnly) {
                  expect(tool.parameters).not.toHaveProperty("properties.archived");
                  expect(tool.parameters).not.toHaveProperty("properties.ownerType");
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
                } else if (scopes[0] === "operator.write") {
                  expect(tool.parameters).toHaveProperty("properties.archived");
                }
                const label = `${scopes[0]} ${name} ${surface}`;
                const args: Record<string, unknown> = { action: "patch", label };
                if (name === "default" && surface === "native") {
                  // Policy hooks can return arguments with prototype defaults.
                  delete args.label;
                  Object.setPrototypeOf(args, {
                    label,
                    icon: "book",
                    targets: [{ sessionKey: TARGET, expectedSessionId: "session-tools-target-id" }],
                  });
                }
                const result = await tool.execute("rename", args);
                expect(result.details).toMatchObject({ status: "updated", updated: ["label"] });
                expect(loadSessionEntry({ agentId: "main", sessionKey })?.label).toBe(label);
                expect(loadSessionEntry({ agentId: "main", sessionKey })?.icon).toBeUndefined();
                expect(
                  loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.label,
                ).toBeUndefined();
              }
              if (name === "default") {
                const absent = (tools: ReturnType<typeof createOpenClawCodingTools>) =>
                  expect(tools.some((tool) => tool.name === "sessions")).toBe(false);
                absent(
                  (
                    await resolveGatewayScopedTools({
                      ...options,
                      cfg: config,
                      surface: "loopback",
                    })
                  ).tools,
                );
                absent(createOpenClawCodingTools({ ...nativeOptions, senderIsOwner: true }));
                absent(
                  createOpenClawCodingTools({
                    ...nativeOptions,
                    conversationCapabilityProfile: defaultsWithoutAdmission,
                  }),
                );
                const unmarked: SandboxToolPolicy = {
                  allow: sandboxConfig.tools.allow,
                  deny: sandboxConfig.tools.deny,
                };
                const narrowed: SandboxToolPolicy = { ...sandboxConfig.tools, allow: ["read"] };
                for (const tools of [unmarked, narrowed]) {
                  absent(
                    createOpenClawCodingTools({
                      ...nativeOptions,
                      sandbox: { ...nativeOptions.sandbox, tools },
                    }),
                  );
                }
              }
            }
          },
        );
      }
    });
  });
});
