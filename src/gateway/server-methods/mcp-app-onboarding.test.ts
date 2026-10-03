import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as pluginMetadata from "../../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import * as sessionAccess from "../session-access-authority.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import * as chatSession from "./chat-send-session.js";
import { mcpAppOnboardingHandlers } from "./mcp-app-onboarding.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
afterEach(() => vi.restoreAllMocks());

it.each(["success", "caller-revoked", "session-replaced", "native-denied"] as const)(
  "hands onboarding to ordinary chat authority through settlement: %s",
  async (scenario) => {
    const fixture = await createFixture({ active: false, persistDuringDispatch: true });
    const pluginRoot = path.join(path.dirname(fixture.scope.storePath), "onboarding-plugin");
    await fs.mkdir(pluginRoot);
    await fs.writeFile(path.join(pluginRoot, "setup.md"), "/setup remains ordinary plugin text");
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "demo",
          rootDir: pluginRoot,
          skills: ["."],
          onboardingSkill: "setup.md",
          enabledByDefault: true,
        },
      ],
    });
    vi.spyOn(pluginMetadata, "getGatewayPluginMetadataSnapshot").mockReturnValue(snapshot);
    const client = createOperatorClient({
      profileName: "onboarding",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    const projection = await createSessionRowProjection({
      cfg: fixture.context.getRuntimeConfig(),
      modelCatalog: [],
    });
    bindSessionRowProjection(fixture.context, () => projection);
    fixture.context.resolveGatewayContext = () => fixture.context;
    const prepareAccess = sessionAccess.prepareGatewaySessionAccessAuthority;
    let access: sessionAccess.GatewaySessionAccessAuthority | undefined;
    const release = vi.fn();
    vi.spyOn(sessionAccess, "prepareGatewaySessionAccessAuthority").mockImplementation(
      async (params) => {
        access = await prepareAccess(params);
        release.mockImplementation(access.release);
        access.release = release;
        return access;
      },
    );
    let chat: GatewayRequestHandlerOptions | undefined;
    const registry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({
        ...mcpAppOnboardingHandlers,
        "chat.send": async (options) => {
          chat = options;
          await handleChatSend(options);
        },
      }),
    );
    fixture.context.getGatewayMethodRegistry = () => registry;
    if (scenario === "native-denied") {
      // The runtime owner decides eligibility; onboarding must not bypass its refusal.
      vi.spyOn(chatSession, "prepareChatSendNativeRuntimeRestriction").mockResolvedValue({
        code: "FORBIDDEN",
        message: "Native runtime admission refused",
      });
    }
    let callerCurrent = true;
    const respond = vi.fn();
    const params = {
      sessionKey: fixture.scope.sessionKey,
      pluginId: "demo",
      idempotencyKey: fixture.params.idempotencyKey,
    };
    try {
      await projection.ensureMaterialized();
      await handleGatewayRequest({
        req: { type: "req", id: "onboarding-request", method: "mcp.app.onboard", params },
        client,
        context: fixture.context,
        isWebchatConnect: () => true,
        respond,
        hasCurrentClientAuthority: () => callerCurrent,
        methodRegistry: registry,
      });
      expect(release).toHaveBeenCalledOnce();
      expect(() => access!.assertCurrent()).toThrow("Session access changed");
      expect(chat?.client?.authenticatedUserProfile?.profileId).toBe(
        client.authenticatedUserProfile?.profileId,
      );
      expect(chat?.client?.internal?.syntheticClient).not.toBe(true);
      expect(chat?.params.suppressCommandInterpretation).toBe(true);
      if (scenario === "native-denied") {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: "Native runtime admission refused" }),
        );
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } else {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
        );
        // Chat retains its own exact target and source after the onboarding router releases.
        expect(() => chat!.sessionMutationAuthorization!.assertCurrent()).not.toThrow();
        if (scenario === "caller-revoked") {
          callerCurrent = false;
          expect(() => chat!.sessionMutationAuthorization!.assertCurrent()).toThrow();
        } else if (scenario === "session-replaced") {
          await patchSessionEntryCore(fixture.scope, () => ({ sessionId: "replacement-session" }));
          await projection.ensureMaterialized();
          expect(() => chat!.sessionMutationAuthorization!.assertCurrent()).toThrow();
        }
        await fixture.finishDispatch();
        if (scenario === "success") {
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
          expect(fixture.context.logGateway.warn).not.toHaveBeenCalledWith(
            expect.stringContaining("user transcript persistence failed"),
          );
          expect(JSON.stringify(loadTranscriptEventsSync(fixture.scope))).toContain(
            "Run the setup skill for plugin demo.",
          );
        }
      }
      expect(fixture.context.chatAbortControllers.size).toBe(0);
      expect(fixture.context.chatQueuedTurns.size).toBe(0);
    } finally {
      await fixture.cleanup();
      projection.dispose();
    }
  },
);
