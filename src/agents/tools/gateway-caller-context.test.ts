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
  getGatewayToolCallerIdentity as getCaller,
  withGatewayPersonalToolUser,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

type CallerIdentity = NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>;
type Caller = Partial<CallerIdentity>;
const defaultCaller = { agentId: "main", sessionKey: "agent:main:session" };
const agentCaller = { agentId: "agent-a", sessionKey: "agent-a:session" };

function withCaller<T>(identity: Caller, run: () => T | Promise<T>) {
  return withGatewayToolCallerIdentity({ ...defaultCaller, ...identity }, run);
}

function withCallers<T>(identities: Caller[], run: () => T | Promise<T>): Promise<T> {
  const [identity, ...nested] = identities;
  return identity ? withCaller(identity, () => withCallers(nested, run)) : Promise.resolve(run());
}

const runInstance = (name: string) => ({ instanceId: `${name}-instance`, runId: `${name}-run` });
const admittedCaller = (name: string, turnSourceChannel: string, admitted = true) => ({
  agentId: name,
  sessionKey: `agent:${name}:session`,
  turnSourceChannel,
  ...(admitted
    ? {
        operationalRunInstance: runInstance(name),
        executionIdentityToken: createExecutionIdentityAdmissionToken(`${name}-run`),
      }
    : {}),
});
const denyTool = (denied: string) => (name: string) => {
  if (name === denied) {
    throw new Error(`${name} denied`);
  }
};

function makeTool(): AnyAgentTool {
  return {
    name: "plugin_tool",
    label: "Plugin tool",
    description: "plugin tool",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: {} })),
  };
}

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
    await withCaller(
      {
        operationalRunInstance: runInstance("source"),
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
      const entered = vi.fn(() => {
        const retained = expectDefined(
          getCaller()?.approvalAuthority,
          "retained approval authority",
        );
        expect(validateAgentRunDelegatedAuthority(retained)).toBe(true);
        lifetime.abort();
        expect(validateAgentRunDelegatedAuthority(retained)).toBe(false);
        expect(validateAgentRunDelegatedAuthority(root)).toBe(true);
      });
      try {
        const pending = withCaller({ operationalRunInstance: run, approvalAuthority: outer }, () =>
          withCaller({ operationalRunInstance: run, approvalAuthority: inner }, entered),
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
    await withCallers(
      [
        {
          sessionEventToolsAllow: ["read", "process"],
          sessionEventSettings: {
            permissionMode: "workspace",
            toolOverrides: { webSearch: false },
          },
          assertToolAllowed: denyTool("exec"),
        },
        {
          sessionEventToolsAllow: ["read", "exec"],
          sessionEventSettings: {
            permissionMode: "full",
            toolOverrides: { mcpServers: { fixture: false } },
          },
          assertToolAllowed: denyTool("process"),
        },
        {},
      ],
      () => {
        const caller = getCaller();
        expect(caller?.sessionEventToolsAllow).toEqual(["read"]);
        expect(caller?.sessionEventSettings).toEqual({
          permissionMode: "workspace",
          toolOverrides: { webSearch: false, mcpServers: { fixture: false } },
        });
        expect(() => caller?.assertToolAllowed?.("exec")).toThrow("exec denied");
        expect(() => caller?.assertToolAllowed?.("process")).toThrow("process denied");
        expect(() => caller?.assertToolAllowed?.("read")).not.toThrow();
      },
    );
  });

  it.each(["full", "guarded"] as const)(
    "retains default permissions through %s wrappers",
    async (permissionMode) => {
      const execute = vi.fn(() => getCaller()?.sessionEventSettings);
      const wrapped = withCallers(
        [{ sessionEventSettings: {} }, { sessionEventSettings: { permissionMode } }, {}],
        execute,
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

  it.each(["outer", "inner"] as const)("retains %s delivery restrictions", async (restricted) => {
    await withCallers(
      ["outer", "inner", "wrapper"].map((scope) =>
        scope === restricted ? { sessionEventDelivery: false } : {},
      ),
      () => expect(getCaller()?.sessionEventDelivery).toBe(false),
    );
  });

  it("preserves tool metadata used by policy and presentation layers", () => {
    const tool = makeTool();
    setPluginToolMeta(tool, { pluginId: "plugin-a", optional: false });
    setChannelAgentToolMeta(tool as never, { channelId: "telegram" });
    setToolTerminalPresentation(tool, () => ({ text: "done" }));

    const beforeWrapped = wrapToolWithBeforeToolCallHook(tool);
    const wrapped = wrapToolWithGatewayCallerIdentity(beforeWrapped, agentCaller);

    expect(getPluginToolMeta(wrapped)).toEqual({ pluginId: "plugin-a", optional: false });
    expect(getChannelAgentToolMeta(wrapped as never)).toEqual({ channelId: "telegram" });
    expect(getToolTerminalPresentation(wrapped)).toBe(getToolTerminalPresentation(tool));
    expect(isToolWrappedWithBeforeToolCallHook(wrapped)).toBe(true);
  });

  it("retains the source receiver while executing in the admitted caller context", async () => {
    const tool = makeTool();
    tool.execute = async function () {
      expect(this).toBe(tool);
      expect(getCaller()).toEqual(agentCaller);
      return { content: [], details: {} };
    };

    const wrapped = wrapToolWithGatewayCallerIdentity(tool, agentCaller);
    await wrapped.execute("caller-context", {});
    expect(getCaller()).toBeUndefined();
  });

  it("applies caller identity to private preparation and execution", async () => {
    const seen: unknown[] = [];
    const tool = attachInternalToolExecutionPreparer(makeTool(), async () => {
      seen.push(getCaller());
      return {
        kind: "ready",
        args: {},
        execute: async () => {
          seen.push(getCaller());
          return { content: [], details: {} };
        },
        dispose: vi.fn(),
      };
    });
    const wrapped = wrapToolWithGatewayCallerIdentity(tool, agentCaller);
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(wrapped),
      "gateway-adapted preparer",
    );

    const prepared = await preparer({ toolCallId: "gateway-call", args: {} });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") {
      await prepared.execute();
    }

    expect(seen).toEqual([agentCaller, agentCaller]);
  });

  it("pins caller identity to the Gateway present at admission", async () => {
    const admitted = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    admitted.resolveGatewayContext = () => admitted;
    replacement.resolveGatewayContext = () => replacement;
    let current = admitted;
    const selectGateway = vi.fn(() => current);
    const captureResolver = () =>
      expectDefined(getCaller()?.gatewayContextResolver, "admitted caller Gateway");

    const first = await withCaller({ gatewayContextResolver: selectGateway }, () => {
      const resolveGatewayContext = captureResolver();
      expect(resolveGatewayContext()).toBe(admitted);
      current = replacement;
      expect(resolveGatewayContext()).toBeUndefined();
      return resolveGatewayContext;
    });
    const second = await withCaller({ gatewayContextResolver: selectGateway }, captureResolver);
    const callsBeforeLookup = selectGateway.mock.calls.length;
    expect(getCanonicalGatewayContextResolver(first)).toBe(admitted.resolveGatewayContext);
    expect(getCanonicalGatewayContextResolver(second)).toBe(replacement.resolveGatewayContext);
    expect(selectGateway).toHaveBeenCalledTimes(callsBeforeLookup);
    expect(first()).toBeUndefined();
    expect(second()).toBe(replacement);
  });

  it("scopes nested approval ownership without replacing the native runtime owner", async () => {
    await withCaller(
      { operationalRunInstance: runInstance("owner"), approvalOwnerPluginId: "codex" },
      async () => {
        await withGatewayToolApprovalOwner("policy-plugin", async () => {
          expect(getCaller()?.approvalOwnerPluginId).toBe("policy-plugin");
        });
        expect(getCaller()?.approvalOwnerPluginId).toBe("codex");
      },
    );
  });

  it.each(["wrapper", "admitted run"] as const)(
    "selects the authority root for a nested %s",
    async (kind) => {
      const distinct = kind === "admitted run";
      const outer = admittedCaller("outer", "telegram");
      const child = admittedCaller("child", "discord", distinct);
      const identity = await withCallers(
        [
          {
            ...outer,
            ...(distinct ? { fullPermission: true, cronSelfManagementJobId: "outer-job" } : {}),
          },
          {
            ...child,
            ...(!distinct ? { cronSelfManagementJobId: "job-1" } : {}),
          },
        ],
        getCaller,
      );
      expect(identity).toMatchObject(
        distinct
          ? { ...child, cronSelfManagementJobId: undefined, fullPermission: undefined }
          : { ...outer, cronSelfManagementJobId: "job-1" },
      );
    },
  );

  it.each([
    [undefined, true, true],
    [true, undefined, true],
    [true, false, false],
    [false, true, false],
  ])("narrows same-run Full Access from %s and %s to %s", async (outer, inner, expected) => {
    await withCallers(
      [outer, inner].map((fullPermission) => ({ fullPermission })),
      () => expect(getCaller()?.fullPermission).toBe(expected),
    );
  });

  it.each(["same", "distinct"] as const)("retains %s run receipts and signals", async (kind) => {
    const sameRun = kind === "same";
    const run = runInstance("outer");
    let outerActive = sameRun;
    let innerActive = true;
    const outer = vi.fn(() => outerActive);
    const inner = vi.fn(() => innerActive);
    const outerSignal = sameRun ? new AbortController().signal : AbortSignal.abort();
    const innerSignal = new AbortController().signal;
    const identity = await withCallers(
      [outer, inner].map((receiptAuthority, index) => ({
        operationalRunInstance: index === 0 || sameRun ? run : runInstance("child"),
        receiptAuthority,
        approvalSignals: [index === 0 ? outerSignal : innerSignal],
      })),
      getCaller,
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
  });
});
