import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { getCanonicalGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "../channel-tool-metadata.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

describe("gateway caller context wrapper", () => {
  it("keeps prepared caller authority live through personal selection without synchronous source reads", async () => {
    const refusal = new Error("requesting session authority was revoked");
    let active = true;
    const assertSourceCurrent = () => {
      if (!active) {
        throw refusal;
      }
    };
    const synchronousSource = vi.fn(assertSourceCurrent);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "source-profile",
      scopes: ["operator.write"],
      assertCurrent: Object.assign(synchronousSource, {
        prepareSessionSource: async () => ({ assertCurrent: assertSourceCurrent, checks: [] }),
      }),
    });
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:source",
        operationalRunInstance: { instanceId: "source-instance", runId: "source-run" },
        operatorAuthority,
        receiptAuthority: () => true,
        cronAuthorityCheck: () => false,
      },
      () =>
        withGatewayPersonalToolUser(undefined, async () => {
          const assertion = expectDefined(captureGatewayToolCallerAssertion(), "captured caller");
          expect(() => assertion("sessions.abort")).not.toThrow();
          expect(() => assertion("cron.update")).toThrow(
            "Automation caller authority is no longer active.",
          );
          synchronousSource.mockClear();
          const prepared = await prepareSessionSourceAuthority(assertion);
          try {
            prepared.assertCurrent();
            expect(synchronousSource).not.toHaveBeenCalled();
            active = false;
            expect(() => prepared.assertCurrent()).toThrow(refusal);
            expect(() => assertion("sessions.abort")).toThrow(refusal);
            expect(synchronousSource).not.toHaveBeenCalled();
          } finally {
            await prepared.release?.();
          }
        }),
    );
  });

  it.each(["outer", "inner", "unrelated"] as const)(
    "narrows nested approval scopes: %s",
    async (narrower) => {
      const run = { instanceId: `context-${narrower}`, runId: `context-${narrower}` };
      const root = claimAgentRunDelegatedAuthority(run);
      const lifetime = new AbortController();
      const worker = claimAgentRunApprovalAuthority(root, [lifetime.signal]);
      const outer = narrower === "inner" ? root : worker;
      const inner =
        narrower === "unrelated"
          ? claimAgentRunApprovalAuthority(root, [new AbortController().signal])
          : narrower === "inner"
            ? worker
            : root;
      const caller = {
        agentId: "main",
        sessionKey: "agent:main:scope",
        operationalRunInstance: run,
      };
      const entered = vi.fn(() => {
        const retained = expectDefined(
          getGatewayToolCallerIdentity()?.approvalAuthority,
          "retained approval authority",
        );
        expect(validateAgentRunDelegatedAuthority(retained)).toBe(true);
        lifetime.abort();
        expect(validateAgentRunDelegatedAuthority(retained)).toBe(false);
        expect(validateAgentRunDelegatedAuthority(root)).toBe(true);
      });
      try {
        const pending = withGatewayToolCallerIdentity({ ...caller, approvalAuthority: outer }, () =>
          withGatewayToolCallerIdentity({ ...caller, approvalAuthority: inner }, entered),
        );
        if (narrower === "unrelated") {
          await expect(pending).rejects.toThrow("approval scopes do not retain the same source");
          expect(entered).not.toHaveBeenCalled();
        } else {
          await pending;
          expect(entered).toHaveBeenCalledOnce();
        }
      } finally {
        releaseAgentRunDelegatedAuthority(root);
      }
    },
  );

  it("preserves every delegated tool restriction through same-run wrappers", async () => {
    const identity = { agentId: "main", sessionKey: "agent:main:preview" };
    await withGatewayToolCallerIdentity(
      {
        ...identity,
        sessionEventToolsAllow: ["read", "process"],
        sessionEventSettings: { permissionMode: "workspace" },
        assertToolAllowed: (name) => {
          if (name === "exec") {
            throw new Error("exec denied");
          }
        },
      },
      () =>
        withGatewayToolCallerIdentity(
          {
            ...identity,
            sessionEventToolsAllow: ["read", "exec"],
            sessionEventSettings: { permissionMode: "full" },
            assertToolAllowed: (name) => {
              if (name === "process") {
                throw new Error("process denied");
              }
            },
          },
          () =>
            withGatewayToolCallerIdentity(identity, () => {
              const caller = getGatewayToolCallerIdentity();
              expect(caller?.sessionEventToolsAllow).toEqual(["read"]);
              expect(caller?.sessionEventSettings).toEqual({ permissionMode: "workspace" });
              expect(() => caller?.assertToolAllowed?.("exec")).toThrow("exec denied");
              expect(() => caller?.assertToolAllowed?.("process")).toThrow("process denied");
              expect(() => caller?.assertToolAllowed?.("read")).not.toThrow();
            }),
        ),
    );
  });

  it.each(["full", "guarded"] as const)(
    "retains a captured default posture through a nested %s permission wrapper",
    async (permissionMode) => {
      const identity = { agentId: "main", sessionKey: "agent:main:default-permission" };
      const execute = vi.fn(() => getGatewayToolCallerIdentity()?.sessionEventSettings);
      const wrapped = withGatewayToolCallerIdentity({ ...identity, sessionEventSettings: {} }, () =>
        withGatewayToolCallerIdentity(
          { ...identity, sessionEventSettings: { permissionMode } },
          () => withGatewayToolCallerIdentity(identity, execute),
        ),
      );
      if (permissionMode === "guarded") {
        await expect(wrapped).rejects.toThrow("changed between default and explicit permissions");
        expect(execute).not.toHaveBeenCalled();
      } else {
        await expect(wrapped).resolves.toEqual({ permissionMode: undefined });
        expect(execute).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["outer", "inner"] as const)(
    "preserves the %s caller's automatic-delivery restriction through delegation",
    async (restricted) => {
      const identity = { agentId: "main", sessionKey: "agent:main:private-followup" };
      await withGatewayToolCallerIdentity(
        {
          ...identity,
          ...(restricted === "outer" ? { sessionEventDelivery: false as const } : {}),
        },
        () =>
          withGatewayToolCallerIdentity(
            {
              ...identity,
              ...(restricted === "inner" ? { sessionEventDelivery: false as const } : {}),
            },
            () =>
              withGatewayToolCallerIdentity(identity, () => {
                expect(getGatewayToolCallerIdentity()?.sessionEventDelivery).toBe(false);
              }),
          ),
      );
    },
  );

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

  it("applies caller identity to private preparation and execution", async () => {
    const seen: unknown[] = [];
    const tool = attachInternalToolExecutionPreparer(
      {
        name: "plugin_tool",
        label: "Plugin tool",
        description: "plugin tool",
        parameters: Type.Object({}),
        execute: vi.fn(async () => ({ content: [], details: {} })),
      },
      async () => {
        seen.push(getGatewayToolCallerIdentity());
        return {
          kind: "ready",
          args: {},
          execute: async () => {
            seen.push(getGatewayToolCallerIdentity());
            return { content: [], details: {} };
          },
          dispose: vi.fn(),
        };
      },
    );
    const identity = { agentId: "agent-a", sessionKey: "agent-a:session" };
    const wrapped = wrapToolWithGatewayCallerIdentity(tool as never, identity);
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(wrapped),
      "gateway-adapted preparer",
    );

    const prepared = await preparer({ toolCallId: "gateway-call", args: {} });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") {
      await prepared.execute();
    }

    expect(seen).toEqual([identity, identity]);
  });

  it("pins caller identity to the Gateway present at admission", async () => {
    const admitted = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    admitted.resolveGatewayContext = () => admitted;
    replacement.resolveGatewayContext = () => replacement;
    let current = admitted;
    const selectGateway = vi.fn(() => current);

    const first = await withGatewayToolCallerIdentity(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        gatewayContextResolver: selectGateway,
      },
      () => {
        const resolveGatewayContext = expectDefined(
          getGatewayToolCallerIdentity()?.gatewayContextResolver,
          "admitted caller Gateway",
        );
        expect(resolveGatewayContext()).toBe(admitted);
        current = replacement;
        expect(resolveGatewayContext()).toBeUndefined();
        return resolveGatewayContext;
      },
    );
    const second = await withGatewayToolCallerIdentity(
      {
        agentId: "agent-a",
        sessionKey: "agent-a:session",
        gatewayContextResolver: selectGateway,
      },
      () =>
        expectDefined(
          getGatewayToolCallerIdentity()?.gatewayContextResolver,
          "replacement caller Gateway",
        ),
    );
    const callsBeforeLookup = selectGateway.mock.calls.length;
    expect(getCanonicalGatewayContextResolver(first)).toBe(admitted.resolveGatewayContext);
    expect(getCanonicalGatewayContextResolver(second)).toBe(replacement.resolveGatewayContext);
    expect(selectGateway).toHaveBeenCalledTimes(callsBeforeLookup);
    expect(first()).toBeUndefined();
    expect(second()).toBe(replacement);
  });

  it("scopes nested approval ownership without replacing the native runtime owner", async () => {
    let nestedOwner: string | undefined;
    let restoredOwner: string | undefined;

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        approvalOwnerPluginId: "codex",
      },
      async () => {
        await withGatewayToolApprovalOwner("policy-plugin", async () => {
          nestedOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
        });
        restoredOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
      },
    );

    expect(nestedOwner).toBe("policy-plugin");
    expect(restoredOwner).toBe("codex");
  });

  it.each(["wrapper", "admitted run"] as const)(
    "selects the authority root for a nested %s",
    async (kind) => {
      const outerRun = { instanceId: "outer-instance", runId: "outer-run" };
      const childRun = { instanceId: "child-instance", runId: "child-run" };
      const outerToken = createExecutionIdentityAdmissionToken("outer-run");
      const childToken = createExecutionIdentityAdmissionToken("child-run");
      const distinct = kind === "admitted run";
      const identity = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:session-1",
          operationalRunInstance: outerRun,
          executionIdentityToken: outerToken,
          turnSourceChannel: "telegram",
          ...(distinct ? { fullPermission: true, cronSelfManagementJobId: "outer-job" } : {}),
        },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "child",
              sessionKey: "agent:child:session-2",
              turnSourceChannel: "discord",
              ...(distinct
                ? { operationalRunInstance: childRun, executionIdentityToken: childToken }
                : { cronSelfManagementJobId: "job-1" }),
            },
            () => getGatewayToolCallerIdentity(),
          ),
      );
      expect(identity).toMatchObject(
        distinct
          ? {
              agentId: "child",
              sessionKey: "agent:child:session-2",
              operationalRunInstance: childRun,
              executionIdentityToken: childToken,
              turnSourceChannel: "discord",
            }
          : {
              agentId: "main",
              sessionKey: "agent:main:session-1",
              operationalRunInstance: outerRun,
              executionIdentityToken: outerToken,
              turnSourceChannel: "telegram",
              cronSelfManagementJobId: "job-1",
            },
      );
      if (distinct) {
        expect(identity?.cronSelfManagementJobId).toBeUndefined();
        expect(identity?.fullPermission).toBeUndefined();
      }
    },
  );

  it.each([
    [undefined, true, true],
    [true, undefined, true],
    [true, false, false],
    [false, true, false],
  ])("narrows same-run Full Access from %s and %s to %s", async (outer, inner, expected) => {
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:session", fullPermission: outer },
      () =>
        withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: "agent:main:session", fullPermission: inner },
          () => expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(expected),
        ),
    );
  });

  it.each(["same", "distinct"] as const)(
    "retains receipt authority and signals for %s nested runs",
    async (kind) => {
      const sameRun = kind === "same";
      const run = { instanceId: "outer-instance", runId: "outer-run" };
      let outerActive = sameRun;
      let innerActive = true;
      const outer = vi.fn(() => outerActive);
      const inner = vi.fn(() => innerActive);
      const outerSignal = sameRun ? new AbortController().signal : AbortSignal.abort();
      const innerSignal = new AbortController().signal;
      const identity = await withGatewayToolCallerIdentity(
        {
          agentId: "outer",
          sessionKey: "agent:outer:session",
          operationalRunInstance: run,
          receiptAuthority: outer,
          approvalSignals: [outerSignal],
        },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "inner",
              sessionKey: "agent:inner:session",
              operationalRunInstance: sameRun
                ? run
                : { instanceId: "child-instance", runId: "child-run" },
              receiptAuthority: inner,
              approvalSignals: [innerSignal],
            },
            () => getGatewayToolCallerIdentity(),
          ),
      );
      expect(identity?.receiptAuthority?.()).toBe(true);
      if (sameRun) {
        outerActive = false;
        expect(identity?.receiptAuthority?.()).toBe(false);
        outerActive = true;
        innerActive = false;
        expect(identity?.receiptAuthority?.()).toBe(false);
        expect(outer).toHaveBeenCalledTimes(3);
        expect(inner).toHaveBeenCalledTimes(3);
        expect(identity?.approvalSignals).toEqual([outerSignal, innerSignal]);
      } else {
        expect(inner).toHaveBeenCalledOnce();
        expect(outer).not.toHaveBeenCalled();
        expect(identity?.approvalSignals).toEqual([innerSignal]);
      }
    },
  );
});
