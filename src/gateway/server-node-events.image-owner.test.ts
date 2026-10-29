import "./server-node-events.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { handleNodeEvent } from "./server-node-events.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

const { buildSessionLookup, buildNodeEventContext, runtimeMocks } =
  await import("./server-node-events.test-support.js");

beforeEach(() => {
  resetGatewayWorkAdmission();
  runtimeMocks.agentCommandFromIngress.mockClear();
  runtimeMocks.resolveSessionModelRef.mockClear();
  runtimeMocks.upsertSessionEntryCore.mockImplementation(async (_scope, patch) => patch);
  runtimeMocks.persistInboundImagesForTranscript.mockResolvedValue({
    entries: [],
    omission: "none",
  });
});
afterEach(resetGatewayWorkAdmission);

it.each([
  ["node-share", "agent:main:node-share", "main"],
  ["global", "global", "main"],
  ["agent:personal:share", "agent:personal:share", "personal"],
])(
  "dispatches an image share to the resolved owner of %s",
  async (sessionKey, canonicalKey, agentId) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, personal: {} },
      },
    };
    const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
      "../agents/agent-scope.js",
    );
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    runtimeMocks.parseMessageWithAttachments.mockResolvedValueOnce({
      message: "describe",
      images,
      imageOrder: ["inline"],
      offloadedRefs: [],
    });
    runtimeMocks.loadSessionEntry.mockImplementationOnce((key: string) => ({
      ...buildSessionLookup(key),
      ...resolveSessionStoreIdentity({ cfg, sessionKey: key }),
      cfg,
    }));

    await vi
      .mocked(resolveSessionAgentId)
      .withImplementation(actual.resolveSessionAgentId, async () => {
        await vi.mocked(getRuntimeConfig).withImplementation(
          () => cfg,
          async () => {
            await handleNodeEvent(buildNodeEventContext(), "share", {
              event: "agent.request",
              payloadJSON: JSON.stringify({
                sessionKey,
                message: "describe",
                attachments: [{ type: "image", mimeType: "image/png", content: "aGVsbG8=" }],
              }),
            });
            await vi.waitFor(() =>
              expect(runtimeMocks.agentCommandFromIngress).toHaveBeenCalledWith(
                expect.objectContaining({ sessionKey: canonicalKey, images }),
                expect.anything(),
                expect.anything(),
              ),
            );
            expect(runtimeMocks.resolveSessionModelRef).toHaveBeenCalledWith(
              cfg,
              expect.anything(),
              agentId,
            );
          },
        );
      });
  },
);
