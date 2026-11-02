import { expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as grants from "./mcp-grant-store.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import * as mcp from "./mcp-http.test-support.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => ({ content: [{ type: "text", text: "search result" }] })),
  message: vi.fn(async () => ({ content: [{ type: "text", text: "message result" }] })),
  beforeTool: vi.fn(async ({ params }: { params: unknown }) => ({ blocked: false, params })),
}));
// mock-isolation: Exercise real MCP grants and policy with inert search and message tools.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async () =>
    ["web_search", "message"].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: name === "web_search" ? mocks.search : mocks.message,
    })),
}));
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: mocks.beforeTool,
}));

it("keeps private search denial, callable sibling tools, and live grant revocation on the real HTTP boundary", async () => {
  await withOpenClawTestState({ layout: "split", prefix: "mcp-search-denial-" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      plugins: { enabled: false },
      tools: { allow: ["web_search", "message"] },
    };
    const admission = prepareSystemAgentRunAdmission(
      cfg,
      "search-denial",
      "main",
      "mcp-search-test",
    );
    const controller = new AbortController();
    const requests: Promise<mcp.McpToolResultPayload>[] = [];
    await runQaGatewayFixture(
      async () => {
        setRuntimeConfigSnapshot(cfg);
        const { runtime } = await mcp.startLoopbackServerForTest();
        const admittedRunContext = await admission.admit("gateway");
        const makeGrant = (disabled: boolean) => {
          const grant = grants.mintMcpLoopbackClientGrant({
            context: {
              sessionKey: "agent:main:main",
              senderIsOwner: true,
              ...(disabled ? { webSearchDisabled: true as const } : {}),
            },
            runtimeOwnerToken: runtime.ownerToken,
            admittedRunContext,
          });
          const capture = mcp.captureGrant(grant.token, `search-${disabled}`, runtime.ownerToken);
          return { grant, capture };
        };
        const request = (active: ReturnType<typeof makeGrant>, name?: string) => {
          const pending = mcp
            .sendRaw({
              port: runtime.port,
              token: active.grant.token,
              signal: controller.signal,
              headers: mcp.jsonHeaders({
                "x-openclaw-cli-capture-key": active.capture.captureKey,
                "x-openclaw-web-search-disabled": "false",
              }),
              body: name ? mcp.mcpToolCallBody(name) : mcp.mcpToolsListBody(),
            })
            .then(mcp.readMcpPayload);
          requests.push(pending);
          return pending;
        };
        const disabled = makeGrant(true);
        expect((await request(disabled)).result?.tools?.map(({ name }) => name)).toEqual([
          "message",
        ]);
        expect((await request(disabled, "web_search")).result?.isError).toBe(true);
        expect(mocks.search).not.toHaveBeenCalled();
        expect((await request(disabled, "message")).result?.isError).toBe(false);
        const enabled = makeGrant(false);
        mcp.expectMcpToolNames(await request(enabled), ["web_search"]);
        expect((await request(enabled, "web_search")).result?.isError).toBe(false);
        expect(mocks.search).toHaveBeenCalledOnce();
        for (const change of ["revoke", "replace"] as const) {
          const active = makeGrant(true);
          using gate = createRequestGate();
          mocks.beforeTool.mockImplementationOnce(async ({ params }) => {
            await gate.pause();
            return { blocked: false, params };
          });
          const previousCalls = mocks.message.mock.calls.length;
          const pending = request(active, "message");
          await gate.entered;
          if (change === "revoke") {
            expect(grants.revokeMcpLoopbackClientGrant(active.grant.token)).toBe(true);
          } else {
            expect(grants.activateMcpLoopbackClientGrantCapture(active.capture)).toBeTruthy();
          }
          gate.release();
          expect((await pending).result?.isError).toBe(true);
          expect(mocks.message).toHaveBeenCalledTimes(previousCalls);
        }
      },
      () => controller.abort(),
      () => Promise.allSettled(requests),
      () => closeMcpLoopbackServer(),
      () => admission.close(),
    );
  });
});
