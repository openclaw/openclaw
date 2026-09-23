import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createMediaFollowupRun,
  createReplyMediaContextRuntimeMock,
  makeRunReplyAgentParams,
  resolveOutboundAttachmentFromUrlMock,
  runEmbeddedAgentMock,
  runReplyAgent,
  resetAgentRunnerMediaTestState,
  cleanupAgentRunnerMediaTestState,
} from "./agent-runner.media-paths.test-harness.js";

describe("runReplyAgent media delivery ownership", () => {
  beforeEach(resetAgentRunnerMediaTestState);
  afterEach(cleanupAgentRunnerMediaTestState);

  it.each([
    { sessionKey: "agent:qa:main", provider: "webchat", gateway: true },
    { sessionKey: "global", provider: "slack", gateway: true },
    { sessionKey: "global", provider: "slack", gateway: false },
  ])(
    "keeps $sessionKey media with its prepared delivery owner (gateway=$gateway, provider=$provider)",
    async ({ sessionKey, provider, gateway }) => {
      const { normalizeWebchatReplyMediaPathsForDisplay } =
        await import("../../gateway/server-methods/chat-reply-media.js");
      const { drainGlobalSingletonLifecycleState } =
        await import("../../shared/global-singleton.js");
      const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
      await withOpenClawTestState(
        { layout: "state-only", label: "agent-media-owner" },
        async (state) => {
          try {
            const selected = state.path("project");
            await mkdir(selected, { recursive: true });
            const bytes = Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
              "base64",
            );
            const sources = [
              path.join(selected, "generated.png"),
              state.path("outside", "outside.png"),
            ];
            for (const file of sources) {
              await mkdir(path.dirname(file), { recursive: true });
              await writeFile(file, bytes);
            }
            const config: OpenClawConfig = {
              tools: { allow: ["read"] },
              agents: {
                ownership: "explicit",
                entries: { qa: { workspace: state.workspaceDir }, beta: {} },
              },
            };
            setRuntimeConfigSnapshot(config, config);
            const actual = await vi.importActual<
              typeof import("../../media/outbound-attachment.js")
            >("../../media/outbound-attachment.js");
            resolveOutboundAttachmentFromUrlMock.mockImplementation(
              actual.resolveOutboundAttachmentFromUrl,
            );
            runEmbeddedAgentMock.mockResolvedValue({
              payloads: [
                {
                  text: `here are the charts\n${sources.map((file) => `MEDIA:${file}`).join("\n")}`,
                },
              ],
              meta: { agentMeta: { sessionId: "session", provider: "anthropic", model: "claude" } },
            });
            const result = await runReplyAgent(
              makeRunReplyAgentParams({
                sessionKey,
                provider,
                followupRun: createMediaFollowupRun({
                  run: {
                    agentId: "qa",
                    sessionKey,
                    messageProvider: provider,
                    workspaceDir: selected,
                    permissionMode: "workspace",
                    sessionRoot: selected,
                    config,
                    mediaNormalizationOwner: gateway ? "gateway" : undefined,
                  },
                }),
              }),
            );
            if (!result || Array.isArray(result)) {
              throw new Error("Expected a single reply payload");
            }
            if (gateway) {
              expect(result.mediaUrls).toEqual(sources);
              const [display] = await normalizeWebchatReplyMediaPathsForDisplay({
                cfg: config,
                agentId: "qa",
                sessionKey,
                sessionEntry: {
                  sessionId: "session",
                  updatedAt: 1,
                  permissionMode: "workspace",
                  sessionRoot: selected,
                },
                payloads: [result],
              });
              expect(display?.mediaUrls).toHaveLength(1);
              expect(display?.text).toContain("outside.png: Delivery failed.");
              expect(await readFile(display!.mediaUrls![0]!)).toEqual(bytes);
            } else {
              expect(result.mediaUrls).toHaveLength(2);
              expect(result.mediaUrls).not.toEqual(sources);
              for (const file of result.mediaUrls ?? []) {
                expect(await readFile(file)).toEqual(bytes);
              }
            }
            expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
            expect(createReplyMediaContextRuntimeMock).not.toHaveBeenCalled();
          } finally {
            await drainGlobalSingletonLifecycleState();
          }
        },
      );
    },
  );
});
