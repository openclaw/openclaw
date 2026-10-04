import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import {
  buildAgentQuestionRequestQuestions,
  type AgentQuestionDispatcher,
} from "../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../agents/harness/gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../agents/harness/host-private-capabilities.js";
import { compileStructuredInputForm } from "../agents/harness/structured-input.js";
import {
  bindMcpClientElicitation,
  createMcpClientElicitationHandler,
  runWithMcpElicitationHandler,
} from "../agents/mcp-client-elicitation.js";
import { buildMcpClientCapabilities } from "../agents/mcp-metadata.js";
import {
  getMcpAppViewLease,
  type McpAppPrepareToolCall,
  type McpFormResourceUpload,
} from "../agents/mcp-ui-resource.js";
import { testing as viewTesting } from "../agents/mcp-ui-resource.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { QuestionManager } from "./question-manager.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

const state = vi.hoisted(() => ({ root: "", current: true, uploads: true, apps: true }));
vi.mock("./operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-role-policy.js")>()),
  resolveGatewayOperatorRoleActor: () => undefined,
}));
vi.mock("./server-methods/session-scoped-read.js", () => ({
  retainSessionScopedRead: () => ({
    assertCurrent: () => {
      if (!state.current) {
        throw new Error("revoked");
      }
    },
    release() {},
  }),
}));
vi.mock("./question-session-access.js", () => ({
  prepareQuestionAuthorization: () => ({ target: {}, authorize: () => null }),
  withPreparedQuestionSessions: async (
    _options: unknown,
    _targets: unknown,
    consume: (value: unknown[]) => unknown,
    operation: { assertCurrent: () => void },
  ) => {
    operation.assertCurrent();
    return consume([undefined]);
  },
}));
vi.mock("./server-methods/sessions-files.js", () => ({
  resolveLocalSessionWorkspaceRoot: () => state.root,
}));
vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: () => undefined,
}));
vi.mock("../agents/agent-bundle-mcp-manager-cleanup.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: async () => false,
}));
vi.mock("./mcp-app-reconstruction.js", () => ({ restoreMcpAppView: async () => undefined }));
vi.mock("./mcp-app-standalone.js", () => ({ createMcpAppStandaloneTicket: () => undefined }));

import {
  createMcpAppFormResourceContext,
  createMcpAppWorkspaceUploadProvider,
} from "./mcp-app-form-resources.js";
import { callMcpAppToolWithElicitation } from "./mcp-app-operations.js";
import { mcpAppHandlers } from "./server-methods/mcp-app.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:form";
const cleanups: Array<() => void> = [];
let manager: QuestionManager;
const assertCurrent = () => {
  if (!state.current) {
    throw new Error("revoked");
  }
};
beforeEach(() => {
  state.root = dirs.make("mcp-form-");
  state.current = true;
  state.uploads = true;
  state.apps = true;
  manager = new QuestionManager(createTestGatewayScheduler());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  viewTesting.clearViewStore();
  manager.close();
  await manager.drain();
});

function requestOptions(
  params: Record<string, unknown>,
  requester = "alice",
): GatewayRequestHandlerOptions {
  return {
    params,
    req: { type: "req", id: "current-rpc", method: "mcp.app.formResource", params },
    client: {
      connId: requester,
      connect: { scopes: ["operator.questions", "operator.write"] },
      authenticatedUserProfile: { profileId: requester },
    },
    context: {
      questionManager: manager,
      getRuntimeConfig: () => ({
        mcp: { apps: { enabled: state.apps } },
        gateway: { uploads: { enabled: state.uploads } },
      }),
    },
    isWebchatConnect: () => true,
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
}

async function fixture(
  params: {
    target?: "resource_link" | "mcp_app_tool";
    kind?: "file" | "directory";
    upload?: McpFormResourceUpload;
    register?: boolean;
    requesterId?: string | null;
  } = {},
) {
  const controller = new AbortController();
  const prepareToolCall = vi.fn<McpAppPrepareToolCall>(async () => assertCurrent());
  const readResource = vi.fn(async (_server: string, uri: string) => ({
    contents: [
      {
        uri,
        text: uri.startsWith("ui://") ? "<p>preview</p>" : "private-preview",
        ...(uri.startsWith("ui://") ? { mimeType: "text/html;profile=mcp-app" } : {}),
      },
    ],
  }));
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "preview result" }] }));
  const runtime = {
    sessionId: "session-1",
    sessionKey,
    workspaceDir: state.root,
    mcpAppsEnabled: true,
    assertOwnerCurrent: assertCurrent,
    readResource,
    callTool,
    markUsed() {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {},
      tools: [
        {
          serverName: "origin",
          toolName: "inspect",
          uiResourceUri: "ui://origin/preview",
          uiVisibility: ["app"],
        },
      ],
    }),
  } as unknown as SessionMcpRuntime;
  const preview =
    params.target === "mcp_app_tool"
      ? { type: "mcp_app_tool", name: "inspect", arguments: { id: "declared" } }
      : { type: "resource_link", uri: "parts://declared", name: "Part" };
  const snapshot = {
    mode: "openai/form",
    message: "Pick resources",
    requestedSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": {
            type: "resource",
            options: [
              {
                uri: "parts://choice",
                name: "Part",
                _meta: { "openai/preview": { target: preview } },
              },
            ],
            ...(params.kind ? { userOptions: { kind: params.kind, accept: [".stl"] } } : {}),
          },
        },
      },
    },
  };
  const uploadResources =
    params.upload ??
    (params.kind
      ? createMcpAppWorkspaceUploadProvider({
          workspaceDir: state.root,
          agentId: "main",
          sessionKey,
          assertCurrent,
        })
      : undefined);
  const form = await createMcpAppFormResourceContext({
    origin: {
      runtime,
      serverName: "origin",
      sessionKey,
      agentId: "main",
      requesterId: params.requesterId === null ? undefined : (params.requesterId ?? "alice"),
      assertCurrent,
      prepareToolCall,
    },
    snapshot,
    signal: controller.signal,
    uploadResources,
  });
  cleanups.push(form.dispose);
  const compiled = compileStructuredInputForm({
    schema: snapshot.requestedSchema,
    message: snapshot.message,
    fallbackMessage: "Pick",
    options: {
      protocolName: "OpenAI",
      allowRichForms: true,
      resourceContext: form.context,
      minimumChoiceCount: 1,
    },
  });
  if (compiled.kind !== "ready" || compiled.plan.kind !== "form") {
    throw new Error("fixture compile failed");
  }
  const questions = compiled.plan.fields.map((field) => field.question);
  const requestId = "pending-gateway-id";
  const claim =
    params.register === false
      ? { dispose() {} }
      : registerPendingAgentQuestion({
          questionId: requestId,
          sessionKey,
          agentId: "main",
          questions,
        });
  cleanups.push(claim.dispose);
  if (params.register !== false) {
    manager.request({
      id: requestId,
      sessionKey,
      agentId: "main",
      timeoutMs: 120000,
      questions: buildAgentQuestionRequestQuestions(questions),
    });
  }
  const base = {
    sessionKey,
    agentId: "main",
    viewId: form.context.viewId,
    requestId,
    questionId: questions[0]!.id,
  };
  const invoke = async (action: Record<string, unknown>, requester = "alice") => {
    const options = requestOptions({ ...base, ...action }, requester);
    const respond = vi.fn();
    await mcpAppHandlers["mcp.app.formResource"]!({ ...options, respond });
    return respond.mock.calls[0]!;
  };
  return {
    form,
    invoke,
    base,
    readResource,
    callTool,
    prepareToolCall,
    runtime,
    controller,
    compiled,
    questions,
    claim,
    snapshot,
    uploadResources,
  };
}

describe("registered MCP form resource route", () => {
  it("binds model-created resources to the existing question creator profile and its live authority", async () => {
    let creatorCurrent = true;
    const creator = {
      sessionKey,
      requesterProfileId: "alice",
      fingerprint: "creator",
      project: () => "creator",
      assertActive: () => {
        if (!creatorCurrent) {
          throw new Error("question creator revoked");
        }
      },
    };
    const f = await withAgentQuestionAnswerAuthority(
      createAgentQuestionAnswerAuthority(creator),
      () => fixture({ kind: "file", requesterId: null }),
    );
    const upload = {
      action: "upload",
      files: [{ name: "part.stl", mimeType: "model/stl", content: "AA==" }],
    };
    expect((await f.invoke(upload, "bob"))[0]).toBe(false);
    expect((await f.invoke(upload, "alice"))[0]).toBe(true);
    creatorCurrent = false;
    expect((await f.invoke({ action: "preview", optionIndex: 0 }, "alice"))[0]).toBe(false);
    expect(f.readResource).not.toHaveBeenCalled();
  });
  it("refuses origin metadata that conflicts with the admitted question creator", async () => {
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey,
      requesterProfileId: "alice",
      fingerprint: "creator",
      project: () => "creator",
      assertActive: assertCurrent,
    });
    await expect(
      withAgentQuestionAnswerAuthority(authority, () => fixture({ requesterId: "bob" })),
    ).rejects.toThrow("does not match its question creator");
  });

  it("binds direct SDK forms through the real compiler and pending-question owner, then disposes", async () => {
    const f = await fixture({ kind: "file", register: false });
    const client = new Client(
      { name: "form-host", version: "1" },
      { capabilities: buildMcpClientCapabilities(true) },
    );
    const server = new Server({ name: "origin", version: "1" }, { capabilities: { tools: {} } });
    const call = bindMcpClientElicitation(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const prepare = vi.fn(async () => f.form);
    const handler = createMcpClientElicitationHandler({
      sessionKey,
      agentId: "main",
      assertCurrent,
      prepareResourceContext: prepare,
      gatewayCall: {
        version: 2,
        call: async (request: Parameters<AgentQuestionDispatcher["call"]>[0]) => {
          if (request.method === "question.request") {
            const record = manager.request(
              request.params as Parameters<QuestionManager["request"]>[0],
            );
            expect(record.id).not.toBe("upstream-id");
            return { id: record.id };
          }
          if (request.method !== "question.waitAnswer") {
            throw new Error("unexpected question method");
          }
          const id = (request.params as { id: string }).id;
          const reply = await f.invoke({
            requestId: id,
            action: "upload",
            files: [{ name: "part.stl", mimeType: "model/stl", content: "AA==" }],
          });
          expect(reply[0]).toBe(true);
          return {
            status: "answered",
            answers: { answers: { files: [reply[1].resources[0].uri] } },
          };
        },
      },
    });
    try {
      server.setRequestHandler(CallToolRequestSchema, async () => {
        const result = await server.request(
          { method: "openai/elicitation/create", params: f.snapshot },
          z.object({ action: z.string(), content: z.record(z.string(), z.unknown()).optional() }),
        );
        return { content: [], structuredContent: result };
      });
      const result = await runWithMcpElicitationHandler(handler, () =>
        call(f.controller.signal, () => client.callTool({ name: "pick" })),
      );
      expect(result.structuredContent).toEqual({
        action: "accept",
        content: { files: [expect.stringMatching(/^file:/)] },
      });
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.any(Number),
          snapshot: expect.objectContaining({ mode: "openai/form" }),
        }),
      );
      const record = manager.list()[0]!;
      expect((await f.invoke({ requestId: record.id, action: "preview", optionIndex: 0 }))[0]).toBe(
        false,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("uses the current Gateway registry for App tool elicitation without synthetic caller authority", async () => {
    const f = await fixture({ kind: "file", register: false });
    const { createGatewayMethodRegistry, createCoreGatewayMethodDescriptors } =
      await import("./methods/registry.js");
    const options = requestOptions({});
    options.client!.connect.scopes = ["operator.admin"];
    let pendingId = "";
    let pendingViewId = "";
    const registry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({
        "question.request": async (request: GatewayRequestHandlerOptions) => {
          expect(request.client).toBe(options.client);
          const record = manager.request(
            request.params as Parameters<QuestionManager["request"]>[0],
          );
          pendingId = record.id;
          const viewId = record.questions[0]?.resource?.viewId;
          if (!viewId) {
            throw new Error("Question did not retain its form resource owner");
          }
          pendingViewId = viewId;
          request.respond(true, { id: record.id });
        },
        "question.waitAnswer": async (request: GatewayRequestHandlerOptions) => {
          expect(request.client).toBe(options.client);
          const reply = await f.invoke({
            requestId: pendingId,
            viewId: pendingViewId,
            action: "upload",
            files: [{ name: "part.stl", mimeType: "model/stl", content: "AA==" }],
          });
          expect(reply[0]).toBe(true);
          request.respond(true, {
            status: "answered",
            answers: { answers: { files: [reply[1].resources[0].uri] } },
          });
        },
      }),
    );
    options.context.getGatewayMethodRegistry = () => registry;
    const client = new Client(
      { name: "form-host", version: "1" },
      { capabilities: buildMcpClientCapabilities(true) },
    );
    const server = new Server({ name: "origin", version: "1" }, { capabilities: { tools: {} } });
    const call = bindMcpClientElicitation(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    vi.spyOn(f.runtime, "callTool").mockImplementation(async () =>
      CallToolResultSchema.parse(
        await call(f.controller.signal, () => client.callTool({ name: "pick" })),
      ),
    );
    try {
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [],
        structuredContent: await server.request(
          { method: "openai/elicitation/create", params: f.snapshot },
          z.object({ action: z.string(), content: z.record(z.string(), z.unknown()).optional() }),
        ),
      }));
      const result = await callMcpAppToolWithElicitation({
        options,
        origin: {
          runtime: f.runtime,
          serverName: "origin",
          agentId: "main",
          sessionKey,
          requesterId: "alice",
          assertCurrent,
        },
        toolName: "pick",
        input: {},
        assertCurrent,
        uploadResources: f.uploadResources,
      });
      expect(result.structuredContent).toEqual({
        action: "accept",
        content: { files: [expect.stringMatching(/^file:/)] },
      });
      expect(manager.get(pendingId)?.status).toBe("cancelled");
      expect(
        (
          await f.invoke({
            requestId: pendingId,
            viewId: pendingViewId,
            action: "preview",
            optionIndex: 0,
          })
        )[0],
      ).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads only the originating server’s declared preview using the pending Gateway question id", async () => {
    const f = await fixture();
    const reply = await f.invoke({ action: "preview", optionIndex: 0 });
    expect(reply[0]).toBe(true);
    expect(reply[1]).toEqual({ preview: { contents: [{ text: "private-preview" }] } });
    expect(f.readResource).toHaveBeenCalledWith("origin", "parts://declared");
    expect(
      (await f.invoke({ action: "preview", optionIndex: 0, requestId: "upstream-id" }))[0],
    ).toBe(false);
    expect(
      (
        await f.invoke({
          action: "preview",
          optionIndex: 0,
          target: { type: "resource_link", uri: "parts://secret" },
        })
      )[0],
    ).toBe(false);
    expect((await f.invoke({ action: "preview", optionIndex: 1 }))[0]).toBe(false);
    expect(f.readResource).toHaveBeenCalledTimes(1);
  });

  it("rejects other requesters, sessions and forged pending records even when viewId was copied", async () => {
    const f = await fixture();
    expect((await f.invoke({ action: "preview", optionIndex: 0 }, "bob"))[0]).toBe(false);
    expect(
      (await f.invoke({ action: "preview", optionIndex: 0, sessionKey: "agent:main:other" }))[0],
    ).toBe(false);
    manager.request({
      id: "forged",
      sessionKey,
      agentId: "main",
      timeoutMs: 120000,
      questions: buildAgentQuestionRequestQuestions(f.questions),
    });
    expect((await f.invoke({ action: "preview", optionIndex: 0, requestId: "forged" }))[0]).toBe(
      false,
    );
    expect(f.readResource).not.toHaveBeenCalled();
  });

  it("does not rebind an identical public question ID to a replacement manager entry", async () => {
    const f = await fixture();
    manager.close();
    await manager.drain();
    manager = new QuestionManager(createTestGatewayScheduler());
    manager.request({
      id: f.base.requestId,
      sessionKey,
      agentId: "main",
      timeoutMs: 120000,
      questions: buildAgentQuestionRequestQuestions(f.questions),
    });
    expect((await f.invoke({ action: "preview", optionIndex: 0 }))[0]).toBe(false);
    expect(f.readResource).not.toHaveBeenCalled();
  });

  it("releases form authority when the actual pending question owner retires", async () => {
    const f = await fixture();
    f.claim.dispose();
    expect((await f.invoke({ action: "preview", optionIndex: 0 }))[0]).toBe(false);
    expect(f.readResource).not.toHaveBeenCalled();
  });

  it.each(["origin", "upload policy", "apps disabled"])(
    "rechecks %s after await before writing uploads",
    async (reason) => {
      const gate = createDeferred();
      const entered = createDeferred();
      const provider = createMcpAppWorkspaceUploadProvider({
        workspaceDir: state.root,
        sessionKey,
        agentId: "main",
        assertCurrent,
      });
      const f = await fixture({
        kind: "file",
        upload: async (request) => {
          entered.resolve();
          await gate.promise;
          return provider(request);
        },
      });
      const pending = f.invoke({
        action: "upload",
        files: [{ name: "part.stl", mimeType: "model/stl", content: "AA==" }],
      });
      await entered.promise;
      if (reason === "origin") {
        state.current = false;
      } else if (reason === "upload policy") {
        state.uploads = false;
      } else {
        state.apps = false;
      }
      gate.resolve();
      expect((await pending)[0]).toBe(false);
      expect(await readdir(state.root)).toEqual([]);
    },
  );

  it("withholds in-flight previews after resolution and retires disposed origins", async () => {
    const f = await fixture();
    const gate = createDeferred<{ contents: Array<{ uri: string; text: string }> }>();
    const entered = createDeferred();
    f.readResource.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const pending = f.invoke({ action: "preview", optionIndex: 0 });
    await entered.promise;
    manager.cancel(f.base.requestId);
    gate.resolve({ contents: [{ uri: "parts://declared", text: "must-not-leak" }] });
    expect((await pending)[0]).toBe(false);
    f.form.dispose();
    expect(f.form.context.isUploadedResource("files", "file:///anything")).toBe(false);
  });

  it("checks the returned approval guard before calling a form preview tool", async () => {
    const f = await fixture({ target: "mcp_app_tool" });
    const guard = vi.fn(() => {
      throw new Error("approval policy changed");
    });
    f.prepareToolCall.mockResolvedValueOnce(guard);
    expect((await f.invoke({ action: "preview", optionIndex: 0 }))[0]).toBe(false);
    expect(guard).toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("prepares App previews with CURRENT request options and disposes their sandbox leases", async () => {
    const f = await fixture({ target: "mcp_app_tool" });
    const reply = await f.invoke({ action: "preview", optionIndex: 0 });
    expect(reply[0]).toBe(true);
    expect(f.prepareToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ req: expect.objectContaining({ id: "current-rpc" }) }),
        toolName: "inspect",
        input: { id: "declared" },
      }),
    );
    expect(f.callTool).toHaveBeenCalledWith(
      "origin",
      "inspect",
      { id: "declared" },
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
    const viewId = reply[1].preview.viewId;
    expect(getMcpAppViewLease(viewId, f.runtime)).toBeDefined();
    f.form.dispose();
    expect(getMcpAppViewLease(viewId, f.runtime)).toBeUndefined();
  });

  it.each(["file", "directory"] as const)(
    "publishes real %s resources under workspace authority and admits only their field",
    async (kind) => {
      const f = await fixture({ kind });
      const reply = await f.invoke({
        action: "upload",
        files: [
          {
            name: "part.stl",
            mimeType: "model/stl",
            content: Buffer.from("solid part").toString("base64"),
            ...(kind === "directory" ? { relativePath: "parts/part.stl" } : {}),
          },
        ],
      });
      expect(reply[0]).toBe(true);
      const resource = reply[1].resources[0];
      const file =
        kind === "directory"
          ? path.join(fileURLToPath(resource.uri), "part.stl")
          : fileURLToPath(resource.uri);
      expect(await readFile(file, "utf8")).toBe("solid part");
      expect(f.form.context.isUploadedResource("files", resource.uri)).toBe(true);
      expect(f.form.context.isUploadedResource("other", resource.uri)).toBe(false);
      if (f.compiled.kind === "ready" && f.compiled.plan.kind === "form") {
        expect(f.compiled.plan.fields[0]!.decode([resource.uri]).kind).toBe("present");
      }
      f.form.dispose();
      expect(await readFile(file, "utf8")).toBe("solid part");
    },
  );

  it("derives upload restrictions from the live question and never accepts arbitrary URI text", async () => {
    const f = await fixture({ kind: "file" });
    expect(
      (
        await f.invoke({
          action: "upload",
          files: [{ name: "evil.exe", mimeType: "model/stl", content: "AA==" }],
        })
      )[0],
    ).toBe(false);
    expect(
      (
        await f.invoke({
          action: "upload",
          files: [{ name: "../part.stl", mimeType: "model/stl", content: "AA==" }],
        })
      )[0],
    ).toBe(false);
    expect(
      (
        await f.invoke({
          action: "upload",
          files: [{ name: "part.stl", mimeType: "model/stl", content: "AA==" }],
          accept: ["*"],
        })
      )[0],
    ).toBe(false);
    expect(f.form.context.isUploadedResource("files", "file:///arbitrary.stl")).toBe(false);
    state.uploads = false;
    expect(
      (
        await f.invoke({
          action: "upload",
          files: [{ name: "part.stl", mimeType: "model/stl", content: "AA==" }],
        })
      )[0],
    ).toBe(false);
    expect(await readdir(state.root)).toEqual([]);
  });
});
