// Load real Gateway/model owners before the scenario deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { toSandboxProvisioningError } from "../agents/sandbox/provisioning-error.js";
import * as workspaceSandbox from "../agents/workspace-sandbox.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { resolveInboundMediaReference } from "../media/media-reference.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "keeps an accepted document usable after setup fails before the first model request",
  {
    timeout: 90_000,
  },
  async () => {
    const state = await createProductState("chat-attachment-recovery");
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const requests: string[] = [];
    const errors: unknown[] = [];
    const providerServer = productProvider(errors, (body, response) => {
      requests.push(body);
      writeOpenAiResponsesText(response, {
        text: "Acknowledged.",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    });
    const sessionKey = "agent:main:failed-document";
    const rewrittenKey = "agent:main:rewritten-document";
    const sentinel = "ATTACHMENT_RECOVERY_cobalt_orchard_731";
    const control = "ATTACHMENT_CONTROL_amber_lake_482";
    const document = `Read this selection and report its verification phrase: ${sentinel}.\n`;
    const resolveWorkspace = workspaceSandbox.resolveAttemptWorkspaceSandbox;
    const setupFailures = new Set([sessionKey, rewrittenKey]);
    // Inject only the known preparation failure; admission, extraction, persistence,
    // the later attempt and its serialized provider request use the real owners.
    const setup = vi
      .spyOn(workspaceSandbox, "resolveAttemptWorkspaceSandbox")
      .mockImplementation(async (params) => {
        if (params.sessionKey && setupFailures.delete(params.sessionKey)) {
          throw toSandboxProvisioningError(new Error("Synthetic sandbox setup failure"), "docker");
        }
        return resolveWorkspace(params);
      });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let releaseHook = () => {};
    try {
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(providerServer),
        "attachment-recovery",
      );
      provider.config.models[0].input = ["text", "image"];
      const model = productModelConfig(state.workspaceDir, provider);
      const cfg = {
        agents: { defaults: { ...model.defaults, utilityModel: "" } },
        models: model.models,
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: { auth: { mode: "token", token: "synthetic-attachment-recovery" } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: "synthetic-attachment-recovery",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      const client = gateway.client;
      const create = (key: string) =>
        client.request<{ key: string; sessionId: string }>("sessions.create", {
          key,
          agentId: "main",
        });
      const target = await create(sessionKey);
      const send = (key: string, message: string, text?: string) =>
        client.request<{ runId: string; status: string }>("chat.send", {
          sessionKey: key,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
          ...(text
            ? {
                attachments: [
                  {
                    fileName: "selection-comment.txt",
                    mimeType: "text/plain",
                    content: Buffer.from(text).toString("base64"),
                  },
                ],
              }
            : {}),
        });
      const wait = (runId: string) =>
        client.request("agent.wait", { runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
      const failed = await send(sessionKey, "", document);
      expect(failed.status).toBe("started");
      expect(await wait(failed.runId)).toMatchObject({ status: "error" });
      expect(setupFailures.has(sessionKey)).toBe(false);
      expect(requests).toEqual([]);
      const scope = { agentId: "main", sessionKey, sessionId: target.sessionId };
      const storedDocuments = async () =>
        (await loadTranscriptEvents(scope)).flatMap((event) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return message?.role === "user" &&
            readPersistedMediaFacts(message)?.some(
              (fact) => fact.fileName === "selection-comment.txt",
            )
            ? [message]
            : [];
        });
      const initial = await storedDocuments();
      expect(initial).toHaveLength(1);
      const media = expectDefined(
        readPersistedMediaFacts(initial[0]!)?.[0],
        "retained input media",
      );
      const source = expectDefined(
        await resolveInboundMediaReference(expectDefined(media.url, "managed input URI")),
        "retained managed bytes",
      );
      expect(await fs.readFile(source.physicalPath, "utf8")).toBe(document);

      const continued = await send(sessionKey, "Continue with the previous attachment.");
      expect(await wait(continued.runId)).toMatchObject({ status: "ok" });
      expect(requests).toHaveLength(1);
      expect(await storedDocuments()).toHaveLength(1);
      expect(await fs.readFile(source.physicalPath, "utf8")).toBe(document);

      const other = await create("agent:main:document-control");
      const fresh = await send(other.key, "", `Report the verification phrase ${control}.`);
      expect(await wait(fresh.runId)).toMatchObject({ status: "ok" });
      expect(requests).toHaveLength(2);
      // Establish that real extraction ran and the second session did not inherit the first input.
      expect(requests[1]).toContain(control);
      expect(requests[1]).not.toContain(sentinel);
      expect(errors).toEqual([]);
      expect(requests[0]?.includes(sentinel), "recovered document reached the provider").toBe(true);

      const removedCaption = "HOOK_REMOVED_CAPTION_619";
      let rewrites = 0;
      const handler: PluginHookHandlerMap["before_message_write"] = ({ message }) => {
        if (
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes(removedCaption)
        ) {
          rewrites++;
          message.content = "[redacted]";
          return { message };
        }
        return undefined;
      };
      const registry = requireActivePluginRegistry();
      const hook = {
        pluginId: "attachment-rewrite-fixture",
        hookName: "before_message_write" as const,
        source: "test",
        handler,
      };
      registry.typedHooks.push(hook);
      initializeGlobalHookRunner(registry);
      releaseHook = () => {
        const index = registry.typedHooks.indexOf(hook);
        if (index >= 0) {
          registry.typedHooks.splice(index, 1);
        }
      };
      const rewritten = await create(rewrittenKey);
      const rejected = await client.request<{ runId: string }>("agent", {
        sessionKey: rewritten.key,
        message: removedCaption,
        deliver: false,
        idempotencyKey: randomUUID(),
        attachments: [
          {
            fileName: "synthetic.png",
            mimeType: "image/png",
            content:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=",
          },
        ],
      });
      const rejectedOutcome = await wait(rejected.runId);
      expect(rejectedOutcome).toMatchObject({ status: "error" });
      expect(setupFailures.has(rewrittenKey), JSON.stringify(rejectedOutcome)).toBe(false);
      expect(rewrites).toBeGreaterThan(0);
      expect(requests).toHaveLength(2);
      const stored = (
        await loadTranscriptEvents({
          agentId: "main",
          sessionKey: rewritten.key,
          sessionId: rewritten.sessionId,
        })
      ).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message?.role === "user" ? [message] : [];
      });
      expect(stored, JSON.stringify(rejectedOutcome)).toHaveLength(1);
      expect(stored[0]?.content).toBe("[redacted]");
      expect
        .soft(
          JSON.stringify(stored).includes(removedCaption),
          "hook-removed text stayed out of stored metadata",
        )
        .toBe(false);
      const resume = await send(rewritten.key, "Continue.");
      expect(await wait(resume.runId)).toMatchObject({ status: "ok" });
      expect(requests).toHaveLength(3);
      expect
        .soft(
          requests[2]?.includes(removedCaption),
          "hook-removed text stayed out of continuation input",
        )
        .toBe(false);
    } finally {
      releaseHook();
      setup.mockRestore();
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "attachment recovery proof complete" });
        }
      } finally {
        await closeProvider(providerServer);
        vi.unstubAllEnvs();
        await state.cleanup();
      }
    }
  },
);
