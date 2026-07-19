import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import {
  createTurnAuthoritySnapshot,
  isIssuedTurnAuthoritySnapshot,
  rebindTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../channel-tool-metadata.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  createGatewayToolCallerWrapper,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

describe("gateway caller context wrapper", () => {
  it("preserves tool metadata used by policy and presentation layers", () => {
    const tool: AnyAgentTool = {
      name: "plugin_tool",
      label: "Plugin tool",
      description: "plugin tool",
      parameters: Type.Object({}),
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    };
    setPluginToolMeta(tool, { pluginId: "plugin-a", optional: false });
    setChannelAgentToolMeta(tool as never, { channelId: "telegram" });
    setToolTerminalPresentation(tool, () => ({ text: "done" }));

    const beforeWrapped = wrapToolWithBeforeToolCallHook(tool);
    const wrapped = wrapToolWithGatewayCallerIdentity(beforeWrapped, {
      agentId: "agent-a",
      sessionKey: "agent-a:session",
    });

    expect(getPluginToolMeta(wrapped)).toEqual({ pluginId: "plugin-a", optional: false });
    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
    expect(getToolTerminalPresentation(wrapped)).toBe(getToolTerminalPresentation(tool));
    expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
  });

  it("carries only process-issued turn authority bound to the ambient caller", async () => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
    });
    const aliasedTurnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "agent-a",
      sessionKey: "main",
      sessionId: "session-id-a",
      runId: "run-id-a",
      conversationId: "conversation-a",
      trigger: "channel",
    });
    const mismatchedAgentAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
    });
    const mismatchedSessionAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "agent-a",
      sessionKey: "agent:agent-a:other",
    });
    const missingAgentAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      sessionKey: "agent:agent-a:main",
    });
    const missingSessionAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "agent-a",
    });
    const reboundAuthority = rebindTurnAuthoritySnapshot(turnAuthority, {
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
      trigger: "sessions_send",
    });
    if (!reboundAuthority) {
      throw new Error("expected target-rebound authority");
    }
    const seen: unknown[] = [];
    const tool: AnyAgentTool = {
      name: "authority_probe",
      label: "Authority probe",
      description: "authority probe",
      parameters: Type.Object({}),
      execute: vi.fn(async () => {
        seen.push(getGatewayToolCallerIdentity());
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      }),
    };
    const executeWithAuthority = async (
      label: string,
      authority: typeof turnAuthority,
      identity: { agentId?: string; sessionKey?: string } = {},
    ) => {
      const wrapped = wrapToolWithGatewayCallerIdentity(tool, {
        agentId: identity.agentId ?? "agent-a",
        sessionKey: identity.sessionKey ?? "agent:agent-a:main",
        turnAuthority: authority,
      });
      await wrapped.execute?.(label, {});
    };

    await executeWithAuthority("issued", turnAuthority);
    await executeWithAuthority("canonical", aliasedTurnAuthority, {
      agentId: "AGENT-A",
      sessionKey: "main",
    });
    await executeWithAuthority("rebound", reboundAuthority, {
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
    });
    await expect(
      executeWithAuthority("forged", structuredClone(turnAuthority)),
    ).rejects.toThrowError("turn-authority-invalid");
    for (const rejectedAuthority of [
      mismatchedAgentAuthority,
      mismatchedSessionAuthority,
      missingAgentAuthority,
      missingSessionAuthority,
    ]) {
      await expect(
        executeWithAuthority("rejected-binding", rejectedAuthority),
      ).rejects.toThrowError("turn-authority-invalid");
    }

    expect(seen[0]).toMatchObject({
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      turnAuthority,
    });
    expect(seen[1]).toMatchObject({
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      turnAuthority: {
        authorization: {
          agentId: "agent-a",
          sessionKey: "agent:agent-a:main",
          sessionId: "session-id-a",
          runId: "run-id-a",
          conversationId: "conversation-a",
          trigger: "channel",
        },
      },
    });
    const canonicalAuthority = (seen[1] as { turnAuthority?: typeof turnAuthority }).turnAuthority;
    expect(canonicalAuthority).not.toBe(aliasedTurnAuthority);
    expect(isIssuedTurnAuthoritySnapshot(canonicalAuthority)).toBe(true);
    expect(seen[2]).toMatchObject({
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
      turnAuthority: reboundAuthority,
    });
    expect(seen).toHaveLength(3);
  });

  it("clears inherited caller authority while a nested binding is rejected", async () => {
    const outerAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
    });
    const wrongSessionAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-2", senderIsOwner: false },
      agentId: "agent-b",
      sessionKey: "agent:agent-b:other",
    });

    await withGatewayToolCallerIdentity(
      {
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        turnAuthority: outerAuthority,
      },
      async () => {
        expect(getGatewayToolCallerIdentity()?.turnAuthority).toBe(outerAuthority);

        const rejectedRun = vi.fn();
        await expect(
          withGatewayToolCallerIdentity(
            {
              agentId: "agent-b",
              sessionKey: "agent:agent-b:main",
              turnAuthority: structuredClone(outerAuthority),
            },
            rejectedRun,
          ),
        ).rejects.toThrowError("turn-authority-invalid");
        expect(rejectedRun).not.toHaveBeenCalled();
        expect(getGatewayToolCallerIdentity()?.turnAuthority).toBe(outerAuthority);

        const mismatchedRun = vi.fn();
        await expect(
          withGatewayToolCallerIdentity(
            {
              agentId: "agent-b",
              sessionKey: "agent:agent-b:main",
              turnAuthority: wrongSessionAuthority,
            },
            mismatchedRun,
          ),
        ).rejects.toThrowError("turn-authority-invalid");
        expect(mismatchedRun).not.toHaveBeenCalled();

        await withGatewayToolCallerIdentity(undefined, async () => {
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
        });
        expect(getGatewayToolCallerIdentity()?.turnAuthority).toBe(outerAuthority);
      },
    );
  });

  it("preserves a literal global session binding beside its authenticated agent id", async () => {
    const globalAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer", senderIsOwner: false },
      agentId: "work",
      sessionKey: "global",
    });

    await withGatewayToolCallerIdentity(
      { agentId: "work", sessionKey: "global", turnAuthority: globalAuthority },
      async () => {
        expect(getGatewayToolCallerIdentity()).toEqual({
          agentId: "work",
          sessionKey: "global",
          turnAuthority: globalAuthority,
        });
      },
    );
  });

  it("rejects forged authority supplied through the factory before argument preparation", async () => {
    const outerAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "owner", senderIsOwner: true },
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
    });
    const prepareArguments = vi.fn((args: unknown) => args);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "factory_probe",
      label: "Factory probe",
      description: "factory probe",
      parameters: Type.Object({}),
      prepareArguments,
      execute,
    };
    const wrapped = createGatewayToolCallerWrapper("agent-a", {
      agentSessionKey: "agent:agent-a:main",
      turnAuthority: structuredClone(outerAuthority),
    })(tool);

    await withGatewayToolCallerIdentity(
      {
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        turnAuthority: outerAuthority,
      },
      async () => {
        expect(() => wrapped.prepareArguments?.({})).toThrowError("turn-authority-invalid");
        await expect(wrapped.execute("factory-probe", {})).rejects.toThrowError(
          "turn-authority-invalid",
        );
        expect(getGatewayToolCallerIdentity()?.turnAuthority).toBe(outerAuthority);
      },
    );

    expect(prepareArguments).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects issued authority binding mismatches before prepare and execute", async () => {
    const prepareArguments = vi.fn((args: unknown) => args);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const tool: AnyAgentTool = {
      name: "binding_probe",
      label: "Binding probe",
      description: "binding probe",
      parameters: Type.Object({}),
      prepareArguments,
      execute,
    };
    const mismatchedAuthorities = [
      createTurnAuthoritySnapshot({
        principal: { kind: "sender", senderId: "owner", senderIsOwner: true },
        agentId: "agent-b",
        sessionKey: "agent:agent-b:main",
      }),
      createTurnAuthoritySnapshot({
        principal: { kind: "sender", senderId: "owner", senderIsOwner: true },
        agentId: "agent-a",
        sessionKey: "agent:agent-a:other",
      }),
    ];

    for (const turnAuthority of mismatchedAuthorities) {
      const wrapped = createGatewayToolCallerWrapper("agent-a", {
        agentSessionKey: "agent:agent-a:main",
        turnAuthority,
      })(tool);

      expect(() => wrapped.prepareArguments?.({})).toThrowError("turn-authority-invalid");
      await expect(wrapped.execute("binding-probe", {})).rejects.toThrowError(
        "turn-authority-invalid",
      );
    }

    expect(prepareArguments).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps preparation and execution available when turn authority is absent", async () => {
    const seen: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    const prepareArguments = vi.fn((args: unknown) => {
      seen.push(getGatewayToolCallerIdentity());
      return args;
    });
    const execute = vi.fn(async () => {
      seen.push(getGatewayToolCallerIdentity());
      return {
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      };
    });
    const wrapped = createGatewayToolCallerWrapper("agent-a", {
      agentSessionKey: "agent:agent-a:main",
    })({
      name: "legacy_probe",
      label: "Legacy probe",
      description: "legacy probe",
      parameters: Type.Object({}),
      prepareArguments,
      execute,
    });

    expect(wrapped.prepareArguments?.({ value: 1 })).toEqual({ value: 1 });
    await expect(wrapped.execute("legacy-probe", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });

    expect(prepareArguments).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(seen).toEqual([
      { agentId: "agent-a", sessionKey: "agent:agent-a:main" },
      { agentId: "agent-a", sessionKey: "agent:agent-a:main" },
    ]);
  });

  it("distinguishes absent, invalid, and issued authority at the factory binding", async () => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer", senderIsOwner: false },
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
    });
    const seen: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    const prepareArguments = vi.fn((args: unknown) => {
      seen.push(getGatewayToolCallerIdentity());
      return args;
    });
    const execute = vi.fn(async () => {
      seen.push(getGatewayToolCallerIdentity());
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    });
    const tool: AnyAgentTool = {
      name: "factory_state_probe",
      label: "Factory state probe",
      description: "factory state probe",
      parameters: Type.Object({}),
      prepareArguments,
      execute,
    };
    const invoke = async (
      agentId: string | undefined,
      source: Parameters<typeof createGatewayToolCallerWrapper>[1],
    ) => {
      const wrapped = createGatewayToolCallerWrapper(agentId, source)(tool);
      const prepared = wrapped.prepareArguments?.({});
      await wrapped.execute("factory-state-probe", prepared ?? {});
    };

    await expect(invoke(undefined, {})).resolves.toBeUndefined();
    expect(seen).toEqual([undefined, undefined]);
    seen.length = 0;

    for (const binding of [
      {
        agentId: "agent-a",
        source: {
          agentSessionKey: "agent:agent-a:main",
          turnAuthority: structuredClone(turnAuthority),
        },
      },
      {
        agentId: undefined,
        source: { agentSessionKey: "agent:agent-a:main", turnAuthority },
      },
      {
        agentId: "agent-a",
        source: { turnAuthority },
      },
    ]) {
      await expect(invoke(binding.agentId, binding.source)).rejects.toThrowError(
        "turn-authority-invalid",
      );
    }
    expect(seen).toEqual([]);

    await expect(
      invoke("agent-a", {
        agentSessionKey: "agent:agent-a:main",
        turnAuthority,
      }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([
      {
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        turnAuthority,
      },
      {
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        turnAuthority,
      },
    ]);
  });
});
