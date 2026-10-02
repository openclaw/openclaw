import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterAll, beforeAll, expect, it, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import * as fsSafe from "../infra/fs-safe.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { defaultSkillUploadStore } from "../skills/lifecycle/upload-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createGatewayMethodRegistry, type GatewayMethodRegistry } from "./methods/registry.js";
import { skillsUploadHandlers } from "./server-methods/skills-upload.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

type ToolPolicySuite = {
  getConfig: () => Record<string, unknown>;
  setConfig: (config: Record<string, unknown>) => void;
  invokeToolAuthed: (params: {
    tool: string;
    args?: Record<string, unknown>;
    sessionKey?: string;
  }) => Promise<Response>;
};

export function registerToolsInvokeUploadTests({
  getConfig,
  setConfig,
  getPort,
  setMethodRegistry,
  hookMocks,
  postToolsInvoke,
  gatewayAdminHeaders,
  invokeToolsRpc,
  setMainAllowedTools,
  invokeToolAuthed,
  expectOkInvokeResponse,
}: ToolPolicySuite & {
  getPort: () => number;
  setMethodRegistry: (registry: GatewayMethodRegistry) => void;
  hookMocks: {
    uploadToolExecute: Mock<AnyAgentTool["execute"]>;
    runBeforeToolCallHook: Mock<typeof runBeforeToolCallHook>;
  };
  postToolsInvoke: (params: {
    port: number;
    headers?: Record<string, string>;
    body: Record<string, unknown>;
  }) => Promise<Response>;
  gatewayAdminHeaders: () => Record<string, string>;
  invokeToolsRpc: (
    params: Record<string, unknown>,
    scopes?: string[],
    clientInfo?: { id: string; mode: string },
  ) => Promise<
    | [boolean, { ok?: boolean; toolName?: string; output?: unknown; error?: unknown }?, unknown?]
    | undefined
  >;
  setMainAllowedTools: (params: { allow: string[] }) => void;
  expectOkInvokeResponse: (res: Response) => Promise<unknown>;
}): void {
  const dirs = useAutoCleanupTempDirTracker(afterAll);
  let uploadDir: string;
  beforeAll(() => {
    uploadDir = dirs.make("custom-client-upload");
  });
  it.each([
    {
      label: "late-disabled",
      initiallyEnabled: true,
      enabled: false,
      internal: false,
      text: false,
    },
    { label: "disabled", initiallyEnabled: false, enabled: false, internal: false, text: false },
    { label: "enabled", initiallyEnabled: true, enabled: true, internal: false, text: false },
    { label: "internal", initiallyEnabled: false, enabled: false, internal: true, text: false },
    { label: "text", initiallyEnabled: false, enabled: false, internal: false, text: true },
  ])("protects custom plugin final storage: $label", async (scenario) => {
    setMainAllowedTools({ allow: ["client_blob_fixture", "upload-fixture"] });
    getConfig().gateway = { uploads: { enabled: scenario.initiallyEnabled } };
    const fileName = scenario.label + ".txt";
    const destination = path.join(uploadDir, fileName);
    await fs.writeFile(destination, "original");
    const before = await fs.readdir(uploadDir);
    const nativeRoot = fsSafe.root;
    using opening = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const opened = await nativeRoot(...args);
      if (args[0] === uploadDir) {
        getConfig().gateway = { uploads: { enabled: scenario.enabled } };
      }
      return opened;
    });
    const args = {
      directory: uploadDir,
      fileName,
      ...(scenario.text ? {} : { bytes: "client bytes" }),
    };
    const allowed = scenario.enabled || scenario.internal || scenario.text;
    if (scenario.internal) {
      const rpc = await withPluginRuntimeGatewayRequestScope(
        { client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
        () => invokeToolsRpc({ name: "client_blob_fixture", args }),
      );
      expect(rpc?.[1]?.ok).toBe(true);
    } else {
      const res = await invokeToolAuthed({ tool: "client_blob_fixture", args });
      expect.soft(res.status).toBe(allowed ? 200 : 403);
      const body: unknown = await res.json();
      expect.soft(body).toMatchObject(
        allowed
          ? { ok: true }
          : {
              ok: false,
              error: {
                message: expect.stringContaining("gateway.uploads.enabled"),
              },
            },
      );
    }
    expect(await fs.readFile(destination, "utf8")).toBe(
      allowed && !scenario.text ? "client bytes" : "original",
    );
    expect(await fs.readdir(uploadDir)).toEqual(before);
    if (scenario.text) {
      expect(opening).not.toHaveBeenCalled();
    } else {
      expect(opening).toHaveBeenCalledWith(uploadDir);
    }
  });
  it.each([false, true])(
    "carries HTTP input policy into nested archive storage (disabled=%s)",
    async (disabled) => {
      setMainAllowedTools({ allow: ["file_write", "upload-fixture"] });
      getConfig().gateway = { uploads: { enabled: true } };
      getConfig().skills = { install: { allowUploadedArchives: true } };
      setMethodRegistry(
        createGatewayMethodRegistry([
          {
            name: "skills.upload.begin",
            handler: expectDefined(skillsUploadHandlers["skills.upload.begin"], "upload begin"),
            scope: "operator.admin",
            owner: { kind: "core", area: "skills" },
            profileAccess: "independent",
          },
        ]),
      );
      let reachedStorage = false;
      let invocationError: unknown;
      const begin = defaultSkillUploadStore.begin.bind(defaultSkillUploadStore);
      using beginning = vi
        .spyOn(defaultSkillUploadStore, "begin")
        .mockImplementation(async (...args) => {
          await Promise.resolve();
          reachedStorage = true;
          getConfig().gateway = { uploads: { enabled: !disabled } };
          return begin(...args);
        });
      const { db } = openOpenClawStateDatabase();
      const rows = () => db.prepare("SELECT upload_id FROM skill_uploads ORDER BY upload_id").all();
      const before = rows();
      hookMocks.uploadToolExecute.mockImplementationOnce(async (_callId, args) => {
        try {
          const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "operator scope");
          const context = expectDefined(
            scope.resolveGatewayContext?.() ?? scope.context,
            "Gateway context",
          );
          context.getRuntimeConfig = () => getConfig();
          context.getCommittedRuntimeConfig = () => getConfig();
          if (isRecord(args)) {
            delete args.contentBase64;
          }
          await dispatchGatewayMethodInProcess("skills.upload.begin", {
            kind: "skill-archive",
            slug: "nested-policy",
            sizeBytes: 5,
          });
          return { content: [], details: {} };
        } catch (error) {
          invocationError = error;
          throw error;
        }
      });
      const response = await postToolsInvoke({
        port: getPort(),
        headers: gatewayAdminHeaders(),
        body: { tool: "file_write", args: { contentBase64: "cHJvb2Y=" } },
      });
      const body: unknown = await response.json();
      expect(
        reachedStorage,
        invocationError instanceof Error ? invocationError.message : JSON.stringify(body),
      ).toBe(true);
      expect(beginning).toHaveBeenCalledOnce();
      if (disabled) {
        expect.soft(response.status).toBe(403);
        expect.soft(body).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("gateway.uploads.enabled") },
        });
        expect(rows()).toEqual(before);
      } else {
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ ok: true });
        expect(rows()).toHaveLength(before.length + 1);
      }
    },
  );
  it.each([
    { tool: "file_write", args: { contentBase64: "cHJvb2Y=" } },
    { tool: "file_write", args: { contentBase64: "" } },
    { tool: "workboard_attachment_add", args: { contentBase64: "cHJvb2Y=" } },
    { tool: "message", args: { action: "send", buffer: "cHJvb2Y=" } },
    { tool: "message", args: { action: "send", media: "data:image/png;base64,cHJvb2Y=" } },
  ])("blocks new bytes through HTTP and RPC for $tool $args", async ({ tool, args }) => {
    setConfig({ gateway: { uploads: { enabled: false } } });
    const res = await postToolsInvoke({
      port: getPort(),
      headers: gatewayAdminHeaders(),
      body: {
        name: tool,
        args,
        conversationReadOrigin: "delegated",
        internal: { syntheticClient: true },
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: {
        type: "tool_call_blocked",
        message: expect.stringContaining("gateway.uploads.enabled"),
      },
    });
    const rpc = await invokeToolsRpc({ name: tool, args }, ["operator.admin"], {
      id: "gateway-client",
      mode: "backend",
    });
    expect(rpc?.[1]).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: expect.stringContaining("gateway.uploads.enabled") },
    });
    expect(hookMocks.uploadToolExecute).not.toHaveBeenCalled();
    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "default",
      enabled: undefined,
      tool: "file_write",
      args: { contentBase64: "cHJvb2Y=" },
    },
    {
      label: "enabled",
      enabled: true,
      tool: "workboard_attachment_add",
      args: { contentBase64: "cHJvb2Y=" },
    },
    {
      label: "existing-media",
      enabled: false,
      tool: "file_write",
      args: { sourceMediaId: "existing-file" },
    },
    {
      label: "existing-output",
      enabled: false,
      tool: "message",
      args: { action: "send", media: "https://example.test/generated.png" },
    },
    {
      label: "plain-text",
      enabled: false,
      tool: "message",
      args: { action: "send", message: "hello" },
    },
  ])("preserves $label tool use", async ({ enabled, tool, args }) => {
    setMainAllowedTools({ allow: [tool, "upload-fixture"] });
    getConfig().gateway = { uploads: { enabled } };
    const res = await invokeToolAuthed({ tool, args });
    await expectOkInvokeResponse(res);
    const rpc = await invokeToolsRpc({ name: tool, args });
    expect(rpc?.[1]?.ok).toBe(true);
    expect(hookMocks.uploadToolExecute).toHaveBeenCalledTimes(2);
  });

  it("rechecks current upload config after awaited tool preparation", async () => {
    setMainAllowedTools({ allow: ["file_write", "upload-fixture"] });
    getConfig().gateway = { uploads: { enabled: true } };
    hookMocks.runBeforeToolCallHook.mockImplementationOnce(async (input) => {
      getConfig().gateway = { uploads: { enabled: false } };
      return { blocked: false, params: input.params };
    });
    const res = await invokeToolAuthed({ tool: "file_write", args: { contentBase64: "cHJvb2Y=" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("gateway.uploads.enabled") },
    });
    expect(hookMocks.uploadToolExecute).not.toHaveBeenCalled();
  });

  it.each([
    { hookAddsBytes: false, disabled: true },
    { hookAddsBytes: true, disabled: true },
    { hookAddsBytes: false, disabled: false },
  ])(
    "retains upload policy through nested dispatch (hook=$hookAddsBytes, disabled=$disabled)",
    async ({ hookAddsBytes, disabled }) => {
      setMainAllowedTools({ allow: ["file_write", "upload-fixture"] });
      getConfig().gateway = { uploads: { enabled: true } };
      const nodeDispatch = vi.fn<GatewayRequestHandler>(({ respond }) => {
        respond(true, { payload: { ok: true } });
      });
      setMethodRegistry(
        createGatewayMethodRegistry([
          {
            name: "node.invoke",
            handler: nodeDispatch,
            scope: "operator.admin",
            owner: { kind: "core", area: "upload-policy-test" },
            profileAccess: "independent",
          },
        ]),
      );
      if (hookAddsBytes) {
        hookMocks.runBeforeToolCallHook.mockImplementationOnce(async (input) => {
          if (!isRecord(input.params)) {
            throw new Error("Expected file-write hook arguments");
          }
          return { blocked: false, params: { ...input.params, contentBase64: "cHJvb2Y=" } };
        });
      }
      hookMocks.uploadToolExecute.mockImplementationOnce(async (_callId, args) => {
        // Model file-tool preparation yielding before its nested Gateway node request.
        await Promise.resolve();
        if (isRecord(args)) {
          delete args.contentBase64;
        }
        getConfig().gateway = { uploads: { enabled: !disabled } };
        await dispatchGatewayMethodInProcess("node.invoke", {
          nodeId: "upload-policy-node",
          command: "file.write",
          params: { path: "proof.txt", contentBase64: "cHJvb2Y=" },
          idempotencyKey: "late-upload-policy",
        });
        return { content: [], details: {} };
      });
      const res = await postToolsInvoke({
        port: getPort(),
        headers: gatewayAdminHeaders(),
        body: {
          tool: "file_write",
          args: hookAddsBytes ? {} : { contentBase64: "cHJvb2Y=" },
        },
      });
      if (disabled) {
        expect.soft(res.status).toBe(403);
        expect.soft(await res.json()).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("gateway.uploads.enabled") },
        });
        expect.soft(nodeDispatch).not.toHaveBeenCalled();
      } else {
        await expectOkInvokeResponse(res);
        expect(nodeDispatch).toHaveBeenCalledOnce();
      }
      expect(hookMocks.uploadToolExecute).toHaveBeenCalledOnce();
    },
  );

  it("preserves host-attested synthetic RPC tool execution", async () => {
    setMainAllowedTools({ allow: ["file_write", "upload-fixture"] });
    getConfig().gateway = { uploads: { enabled: false } };
    const rpc = await withPluginRuntimeGatewayRequestScope(
      { client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
      () => invokeToolsRpc({ name: "file_write", args: { contentBase64: "cHJvb2Y=" } }),
    );
    expect(rpc?.[1]?.ok).toBe(true);
    expect(hookMocks.uploadToolExecute).toHaveBeenCalledOnce();
  });
}

async function readToolErrorResponse(res: Response) {
  const body: unknown = await res.json();
  if (!isRecord(body) || !isRecord(body.error)) {
    throw new Error("Expected a tool error response body");
  }
  return { ok: body.ok, error: body.error };
}

export function registerToolsInvokeErrorTests({
  getConfig,
  setConfig,
  invokeToolAuthed,
}: ToolPolicySuite): void {
  it("maps tool input/auth errors to 400/403 and unexpected execution errors to 500", async () => {
    setConfig({
      ...getConfig(),
      agents: {
        entries: { main: { tools: { allow: ["tools_invoke_test"] } } },
      },
    });

    const inputRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "input" },
      sessionKey: "main",
    });
    expect(inputRes.status).toBe(400);
    const inputBody = await readToolErrorResponse(inputRes);
    expect(inputBody.ok).toBe(false);
    expect(inputBody.error?.type).toBe("tool_error");
    expect(inputBody.error?.message).toBe("mode invalid");

    const authRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "auth" },
      sessionKey: "main",
    });
    expect(authRes.status).toBe(403);
    const authBody = await readToolErrorResponse(authRes);
    expect(authBody.ok).toBe(false);
    expect(authBody.error?.type).toBe("tool_error");
    expect(authBody.error?.message).toBe("mode forbidden");

    const crashRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "crash" },
      sessionKey: "main",
    });
    expect(crashRes.status).toBe(500);
    const crashBody = await readToolErrorResponse(crashRes);
    expect(crashBody.ok).toBe(false);
    expect(crashBody.error?.type).toBe("tool_error");
    expect(crashBody.error?.message).toBe("tool execution failed");
  });
}

export function createUploadToolFixtures(execute: AnyAgentTool["execute"]) {
  const uploadTools = ["file_write", "workboard_attachment_add", "message"].map((name) => ({
    name,
    label: name,
    description: "Upload boundary fixture",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute,
  }));
  for (const tool of uploadTools) {
    if (tool.name !== "message") {
      setPluginToolMeta(tool, { pluginId: "upload-fixture", optional: true });
    }
  }
  return uploadTools;
}

export function createClientUploadToolFixture(context: OpenClawPluginToolContext): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: "client_blob_fixture",
    label: "Client blob fixture",
    description: "Custom client-input plugin fixture using native storage admission",
    parameters: Type.Object({
      directory: Type.String(),
      fileName: Type.String(),
      bytes: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => {
      if (
        !isRecord(args) ||
        typeof args.directory !== "string" ||
        typeof args.fileName !== "string"
      ) {
        throw new Error("Invalid custom plugin fixture arguments");
      }
      if (typeof args.bytes === "string") {
        const guard = expectDefined(context.assertInputCommitAllowed, "custom plugin input guard");
        const storage = await fsSafe.root(args.directory);
        await storage.write(args.fileName, args.bytes, { assertBeforeMutation: guard });
      }
      return { content: [], details: { accepted: true } };
    },
  };
  setPluginToolMeta(tool, { pluginId: "upload-fixture", optional: true });
  return tool;
}
