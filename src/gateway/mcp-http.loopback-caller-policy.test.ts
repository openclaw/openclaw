import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentRunAdmission } from "../agents/admitted-run-context.js";
import { createOperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import {
  expectMcpResultText,
  makeMessageTool,
  readOkMcpPayload,
  sendLoopbackToolCall,
  startLoopbackServerForTest,
} from "./mcp-http.test-support.js";

// The loopback caller identity must carry the conversation tool-policy assertion
// that tools re-asserting caller policy (for example the GitHub reader) rely on.
// Regression for #201195: without the binding, github_read via the MCP bridge
// always failed with "GitHub reading requires an active github_read tool invocation".

const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({ session: { mainKey: "main" } })));

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ agentId: string; tools: unknown[] }>>(async () => ({
    agentId: "main",
    tools: [
      {
        name: "message",
        label: "Message",
        description: "send a message",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  })),
);

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof resolveGatewayScopedToolsMock>) =>
    resolveGatewayScopedToolsMock(...args),
}));

const activeAdmissions: ReturnType<typeof prepareAgentRunAdmission>[] = [];

async function activeAdmission(runId: string) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: {
        kind: "system",
        boundary: "mcp-http-loopback-caller-policy-test",
        state: "present",
      },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  activeAdmissions.push(admission);
  return await admission.admit("gateway", `gateway-${runId}`);
}

async function createCliGrant(
  runId: string,
  options: { context?: Partial<McpLoopbackRequestContext> } = {},
) {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("expected active MCP loopback runtime");
  }
  const grant = mintMcpLoopbackClientGrant({
    context: { sessionKey: "agent:main:main", senderIsOwner: true, ...options.context },
    runtimeOwnerToken: runtime.ownerToken,
    admittedRunContext: await activeAdmission(runId),
    toolPolicyConfig: getRuntimeConfigMock(),
  });
  const capture = activateMcpLoopbackClientGrantCapture({
    token: grant.token,
    runtimeOwnerToken: runtime.ownerToken,
    captureKey: `capture-${runId}`,
  });
  if (!capture) {
    throw new Error("expected an active CLI grant capture");
  }
  return {
    ...grant,
    scope: {
      token: grant.token,
      headers: { "x-openclaw-cli-capture-key": `capture-${runId}` },
    },
  };
}

beforeEach(() => {
  resolveGatewayScopedToolsMock.mockReset();
});

afterEach(async () => {
  await closeMcpLoopbackServer();
  for (const admission of activeAdmissions.splice(0)) {
    admission.close();
  }
});

describe("loopback caller conversation tool-policy assertion", () => {
  it("binds the caller assertion from the conversation policy for policy-reasserting tools", async () => {
    let toolCallerIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;
    resolveGatewayScopedToolsMock.mockResolvedValue({
      agentId: "main",
      tools: [
        makeMessageTool({
          execute: async () => {
            toolCallerIdentity = getGatewayToolCallerIdentity();
            return { content: [{ type: "text", text: "ok" }] };
          },
        }),
      ],
    });
    await startLoopbackServerForTest();
    const { scope } = await createCliGrant("run-policy-assertion", {
      context: { conversationToolPolicy: { allow: ["github_read"] } },
    });

    expectMcpResultText(
      await readOkMcpPayload(await sendLoopbackToolCall({ ...scope, name: "message" })),
      "ok",
    );
    expect(toolCallerIdentity).toBeDefined();
    expect(typeof toolCallerIdentity!.assertToolAllowed).toBe("function");
    // The conversation policy explicitly allows github_read.
    expect(() => toolCallerIdentity!.assertToolAllowed!("github_read")).not.toThrow();
    // Tools outside the allowlist are denied by the same policy that filtered the catalog.
    expect(() => toolCallerIdentity!.assertToolAllowed!("exec")).toThrow(/not allowed/);
  });

  it("keeps the caller assertion permissive when no conversation policy is set", async () => {
    let toolCallerIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;
    resolveGatewayScopedToolsMock.mockResolvedValue({
      agentId: "main",
      tools: [
        makeMessageTool({
          execute: async () => {
            toolCallerIdentity = getGatewayToolCallerIdentity();
            return { content: [{ type: "text", text: "ok" }] };
          },
        }),
      ],
    });
    await startLoopbackServerForTest();
    const { scope } = await createCliGrant("run-policy-none");

    expectMcpResultText(
      await readOkMcpPayload(await sendLoopbackToolCall({ ...scope, name: "message" })),
      "ok",
    );
    expect(toolCallerIdentity).toBeDefined();
    expect(typeof toolCallerIdentity!.assertToolAllowed).toBe("function");
    // With no conversation policy, the default posture allows any tool the catalog serves.
    expect(() => toolCallerIdentity!.assertToolAllowed!("github_read")).not.toThrow();
  });

  it("expands plugin-id and plugin-group allowances to concrete plugin tool names", async () => {
    let toolCallerIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;
    const githubTool = makeMessageTool({
      name: "github_read",
      execute: async () => {
        toolCallerIdentity = getGatewayToolCallerIdentity();
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    setPluginToolMeta(githubTool, { pluginId: "github", optional: true });
    resolveGatewayScopedToolsMock.mockResolvedValue({
      agentId: "main",
      tools: [githubTool],
    });
    await startLoopbackServerForTest();
    const { scope } = await createCliGrant("run-policy-plugin-groups", {
      context: { conversationToolPolicy: { allow: ["github"] } },
    });

    expectMcpResultText(
      await readOkMcpPayload(await sendLoopbackToolCall({ ...scope, name: "github_read" })),
      "ok",
    );
    expect(toolCallerIdentity).toBeDefined();
    expect(typeof toolCallerIdentity!.assertToolAllowed).toBe("function");
    // The plugin-id "github" expands to the concrete github_read the catalog served.
    expect(() => toolCallerIdentity!.assertToolAllowed!("github_read")).not.toThrow();
    // A non-plugin tool remains outside the allowlist.
    expect(() => toolCallerIdentity!.assertToolAllowed!("exec")).toThrow(/not allowed/);
  });
});
