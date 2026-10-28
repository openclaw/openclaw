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
  setMainAllowedTools: (params: { allow: string[] }) => void;
  invokeToolAuthed: (params: {
    tool: string;
    args?: Record<string, unknown>;
    sessionKey?: string;
  }) => Promise<Response>;
};

export function registerToolsInvokeUploadTests({
  getConfig,
  setConfig,
  setMethodRegistry,
  hookMocks,
  postAdmin,
  invokeToolsRpc,
  setMainAllowedTools,
  invokeToolAuthed,
  expectOkInvokeResponse,
}: ToolPolicySuite & {
  setMethodRegistry: (registry: GatewayMethodRegistry) => void;
  hookMocks: {
    uploadToolExecute: Mock<AnyAgentTool["execute"]>;
    runBeforeToolCallHook: Mock<typeof runBeforeToolCallHook>;
  };
  postAdmin: (body: Record<string, unknown>) => Promise<Response>;
  invokeToolsRpc: (
    params: Record<string, unknown>,
    scopes?: string[],
    clientInfo?: { id: string; mode: string },
  ) => Promise<
    | [boolean, { ok?: boolean; toolName?: string; output?: unknown; error?: unknown }?, unknown?]
    | undefined
  >;
  expectOkInvokeResponse: (res: Response) => Promise<unknown>;
}): void {
  const dirs = useAutoCleanupTempDirTracker(afterAll);
  let uploadDir: string;
  beforeAll(() => {
    uploadDir = dirs.make("custom-client-upload");
  });
  const blockedUpload = {
    ok: false,
    error: { message: expect.stringContaining("gateway.uploads.enabled") },
  };
  const enableUploads = (enabled: boolean) => {
    getConfig().gateway = { uploads: { enabled } };
  };
  const prepareUpload = (tool = "file_write", enabled = true) => {
    setMainAllowedTools({ allow: [tool, "upload-fixture"] });
    enableUploads(enabled);
  };
  const registerMethod = (name: string, handler: GatewayRequestHandler, area: string) =>
    setMethodRegistry(
      createGatewayMethodRegistry([
        {
          name,
          handler,
          scope: "operator.admin",
          owner: { kind: "core", area },
          profileAccess: "independent",
        },
      ]),
    );
  it.each([
    { label: "late-disabled", initiallyEnabled: true, enabled: false, internal: false },
    { label: "enabled", initiallyEnabled: true, enabled: true, internal: false },
    { label: "internal", initiallyEnabled: false, enabled: false, internal: true },
  ])("protects custom plugin final storage: $label", async (scenario) => {
    prepareUpload("client_blob_fixture", scenario.initiallyEnabled);
    const fileName = scenario.label + ".txt";
    const destination = path.join(uploadDir, fileName);
    await fs.writeFile(destination, "original");
    const before = await fs.readdir(uploadDir);
    const nativeRoot = fsSafe.root;
    using opening = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const opened = await nativeRoot(...args);
      if (args[0] === uploadDir) {
        enableUploads(scenario.enabled);
      }
      return opened;
    });
    const args = { directory: uploadDir, fileName, bytes: "client bytes" };
    const allowed = scenario.enabled || scenario.internal;
    if (scenario.internal) {
      const rpc = await withPluginRuntimeGatewayRequestScope(
        { client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
        () => invokeToolsRpc({ name: "client_blob_fixture", args }),
      );
      expect(rpc?.[1]?.ok).toBe(true);
    } else {
      const res = await invokeToolAuthed({ tool: "client_blob_fixture", args });
      expect.soft(res.status).toBe(allowed ? 200 : 403);
      expect.soft(await res.json()).toMatchObject(allowed ? { ok: true } : blockedUpload);
    }
    expect(await fs.readFile(destination, "utf8")).toBe(allowed ? "client bytes" : "original");
    expect(await fs.readdir(uploadDir)).toEqual(before);
    expect(opening).toHaveBeenCalledWith(uploadDir);
  });
  it.each([false, true])(
    "carries HTTP input policy into nested archive storage (disabled=%s)",
    async (disabled) => {
      prepareUpload();
      getConfig().skills = { install: { allowUploadedArchives: true } };
      registerMethod(
        "skills.upload.begin",
        expectDefined(skillsUploadHandlers["skills.upload.begin"], "upload begin"),
        "skills",
      );
      let reachedStorage = false;
      const begin = defaultSkillUploadStore.begin.bind(defaultSkillUploadStore);
      using beginning = vi
        .spyOn(defaultSkillUploadStore, "begin")
        .mockImplementation(async (...args) => {
          await Promise.resolve();
          reachedStorage = true;
          enableUploads(!disabled);
          return begin(...args);
        });
      const { db } = openOpenClawStateDatabase();
      const rows = () => db.prepare("SELECT upload_id FROM skill_uploads ORDER BY upload_id").all();
      const before = rows();
      hookMocks.uploadToolExecute.mockImplementationOnce(async (_callId, args) => {
        const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "operator scope");
        const context = expectDefined(
          scope.resolveGatewayContext?.() ?? scope.context,
          "Gateway context",
        );
        context.getRuntimeConfig = getConfig;
        context.getCommittedRuntimeConfig = getConfig;
        if (isRecord(args)) {
          delete args.contentBase64;
        }
        await dispatchGatewayMethodInProcess("skills.upload.begin", {
          kind: "skill-archive",
          slug: "nested-policy",
          sizeBytes: 5,
        });
        return { content: [], details: {} };
      });
      const response = await postAdmin({ tool: "file_write", args: { contentBase64: "cHJvb2Y=" } });
      const body: unknown = await response.json();
      expect(reachedStorage).toBe(true);
      expect(beginning).toHaveBeenCalledOnce();
      if (disabled) {
        expect.soft(response.status).toBe(403);
        expect.soft(body).toMatchObject(blockedUpload);
        expect(rows()).toEqual(before);
      } else {
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ ok: true });
        expect(rows()).toHaveLength(before.length + 1);
      }
    },
  );
  it.each([
    { tool: "workboard_attachment_add", args: { contentBase64: "cHJvb2Y=" } },
    { tool: "message", args: { action: "send", buffer: "cHJvb2Y=" } },
    { tool: "message", args: { action: "send", media: "data:image/png;base64,cHJvb2Y=" } },
  ])("blocks new bytes through HTTP and RPC for $tool $args", async ({ tool, args }) => {
    setConfig({ gateway: { uploads: { enabled: false } } });
    const res = await postAdmin({
      name: tool,
      args,
      conversationReadOrigin: "delegated",
      internal: { syntheticClient: true },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ...blockedUpload,
      error: { ...blockedUpload.error, type: "tool_call_blocked" },
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
    [true, "workboard_attachment_add", { contentBase64: "cHJvb2Y=" }],
    [false, "message", { action: "send", media: "https://example.test/generated.png" }],
  ] as const)("preserves tool use (uploads=%s): %s", async (enabled, tool, args) => {
    prepareUpload(tool, enabled);
    await expectOkInvokeResponse(await invokeToolAuthed({ tool, args }));
    const rpc = await invokeToolsRpc({ name: tool, args });
    expect(rpc?.[1]?.ok).toBe(true);
    expect(hookMocks.uploadToolExecute).toHaveBeenCalledTimes(2);
  });

  it("rechecks current upload config after awaited tool preparation", async () => {
    prepareUpload();
    hookMocks.runBeforeToolCallHook.mockImplementationOnce(async (input) => {
      enableUploads(false);
      return { blocked: false, params: input.params };
    });
    const res = await invokeToolAuthed({ tool: "file_write", args: { contentBase64: "cHJvb2Y=" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject(blockedUpload);
    expect(hookMocks.uploadToolExecute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains disabled upload policy through nested dispatch (hook=%s)",
    async (hookAddsBytes) => {
      prepareUpload();
      const nodeDispatch = vi.fn<GatewayRequestHandler>(({ respond }) => {
        respond(true, { payload: { ok: true } });
      });
      registerMethod("node.invoke", nodeDispatch, "upload-policy-test");
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
        enableUploads(false);
        await dispatchGatewayMethodInProcess("node.invoke", {
          nodeId: "upload-policy-node",
          command: "file.write",
          params: { path: "proof.txt", contentBase64: "cHJvb2Y=" },
          idempotencyKey: "late-upload-policy",
        });
        return { content: [], details: {} };
      });
      const res = await postAdmin({
        tool: "file_write",
        args: hookAddsBytes ? {} : { contentBase64: "cHJvb2Y=" },
      });
      expect.soft(res.status).toBe(403);
      expect.soft(await res.json()).toMatchObject(blockedUpload);
      expect.soft(nodeDispatch).not.toHaveBeenCalled();
      expect(hookMocks.uploadToolExecute).toHaveBeenCalledOnce();
    },
  );
}

export function registerToolsInvokeErrorTests({
  setMainAllowedTools,
  invokeToolAuthed,
}: Pick<ToolPolicySuite, "setMainAllowedTools" | "invokeToolAuthed">): void {
  it("maps tool input/auth errors to 400/403 and unexpected execution errors to 500", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });
    const request = { tool: "tools_invoke_test", sessionKey: "main" };

    for (const [mode, status, message] of [
      ["input", 400, "mode invalid"],
      ["auth", 403, "mode forbidden"],
      ["crash", 500, "tool execution failed"],
    ] as const) {
      const res = await invokeToolAuthed({ ...request, args: { mode } });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { type: "tool_error", message },
      });
    }
  });
}

export function createUploadToolFixtures(execute: AnyAgentTool["execute"]) {
  return ["file_write", "workboard_attachment_add", "message"].map((name) => {
    const tool = {
      name,
      label: name,
      description: "Upload boundary fixture",
      parameters: Type.Object({}, { additionalProperties: true }),
      execute,
    };
    if (name !== "message") {
      setPluginToolMeta(tool, { pluginId: "upload-fixture", optional: true });
    }
    return tool;
  });
}

export function createClientUploadToolFixture(context: OpenClawPluginToolContext): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: "client_blob_fixture",
    label: "Client blob fixture",
    description: "Custom client-input plugin fixture using native storage admission",
    parameters: Type.Object({
      directory: Type.String(),
      fileName: Type.String(),
      bytes: Type.String(),
    }),
    execute: async (_id, args) => {
      if (
        !isRecord(args) ||
        typeof args.directory !== "string" ||
        typeof args.fileName !== "string" ||
        typeof args.bytes !== "string"
      ) {
        throw new Error("Invalid custom plugin fixture arguments");
      }
      const guard = expectDefined(context.assertInputCommitAllowed, "custom plugin input guard");
      const storage = await fsSafe.root(args.directory);
      await storage.write(args.fileName, args.bytes, { assertBeforeMutation: guard });
      return { content: [], details: { accepted: true } };
    },
  };
  setPluginToolMeta(tool, { pluginId: "upload-fixture", optional: true });
  return tool;
}
