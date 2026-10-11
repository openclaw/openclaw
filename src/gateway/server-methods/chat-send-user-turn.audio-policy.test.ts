import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { MediaUnderstandingScopeConfig } from "../../config/types.tools.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { transcribeAudioAttachments } from "../../media-understanding/audio-preflight.js";
import { createSafeAudioFixtureBuffer } from "../../media-understanding/runner.test-utils.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as chatAttachments from "../chat-attachments.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createAttachments,
  createClientInfo,
  createUserTurnInputController,
} from "./chat-send-user-turn.test-support.js";

const runExec = vi.hoisted(() => vi.fn());
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: (...args: Parameters<typeof runExec>) => runExec(...args),
}));

function requireInputText(input: { text?: string | null }): string {
  if (typeof input.text !== "string") {
    throw new Error("Expected prepared user-turn text");
  }
  return input.text;
}

describe("chat.send voice transcription policy boundary", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => runExec.mockReset().mockResolvedValue({ stdout: "policy-approved voice" }));
  afterEach(() => vi.restoreAllMocks());

  async function prepare(
    scope: MediaUnderstandingScopeConfig,
    assertClientUploadAllowed?: () => void,
    echoFormat?: string,
  ) {
    const dir = tempDirs.make("chat-audio-policy-");
    const mediaPath = path.join(dir, "voice.wav");
    await fs.writeFile(mediaPath, createSafeAudioFixtureBuffer());
    vi.spyOn(chatAttachments, "persistInboundImagesForTranscript").mockResolvedValueOnce({
      entries: [],
      omission: "none",
    });
    const { controller, readInput } = createUserTurnInputController("caption");
    const cfg: OpenClawConfig = {
      // The test exercises an explicit CLI audio model; disable unrelated plugin
      // discovery so the policy boundary stays isolated from global catalog setup.
      plugins: { enabled: false },
      agents: { defaults: { workspace: dir } },
      tools: {
        media: {
          models: [
            {
              type: "cli" as const,
              command: "fixture-transcribe",
              args: ["{{MediaPath}}"],
              capabilities: ["audio"],
            },
          ],
          audio: { enabled: true, echoTranscript: true, scope, echoFormat },
        },
      },
    };
    const prepared = prepareChatSendUserTurn({
      request: {
        inboundMessage: "caption",
        clientInfo: createClientInfo({
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
        }),
        suppressCommandInterpretation: false,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: "run-policy",
        sessionKey: "agent:main:voice-policy",
        cfg,
      },
      admission: {
        originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        assertClientUploadAllowed,
      },
      attachments: createAttachments({
        parsedMessage: "caption",
        mediaPathOffloads: [{ path: mediaPath, contentType: "audio/wav", workspaceDir: dir }],
        offloadedRefs: [
          {
            mediaRef: "media://inbound/voice.wav",
            id: "voice.wav",
            path: mediaPath,
            kind: "audio",
            mimeType: "audio/wav",
            label: "voice.wav",
            sizeBytes: (await fs.stat(mediaPath)).size,
            sourceIndex: 0,
          },
        ],
      }),
      client: null,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });
    const input = await readInput();
    return { prepared, input, cfg };
  }

  it.each([
    { channel: "webchat" },
    { keyPrefix: "agent:main:voice-policy" },
    { chatType: "direct" as const },
  ])("rejects a matching scope rule before transcription command I/O: %j", async (match) => {
    await withEnvAsync({ PATH: "" }, async () => {
      const { prepared, input } = await prepare({
        default: "allow",
        rules: [{ action: "deny", match }],
      });
      expect(input.text).toBe("caption");
      expect(prepared.ctx.Transcript).toBeUndefined();
      expect(prepared.ctx.media?.[0]?.transcribed).not.toBe(true);
      expect(runExec).not.toHaveBeenCalled();
    });
  });

  it("rechecks UI admission after media preparation and before transcription I/O", async () => {
    await withEnvAsync({ PATH: "" }, async () => {
      let assertions = 0;
      const assertClientUploadAllowed = vi.fn(() => {
        assertions += 1;
        if (assertions >= 2) {
          throw new Error("admission expired");
        }
      });
      await expect(prepare({ default: "allow" }, assertClientUploadAllowed)).rejects.toThrow(
        "admission expired",
      );
      expect(assertions).toBe(3);
      expect(runExec).not.toHaveBeenCalled();
    });
  });

  it.each(["Voice note received", ""])(
    "preserves spoken input with static echo format %j",
    async (echoFormat) => {
      await withEnvAsync({ PATH: "" }, async () => {
        const { prepared, input, cfg } = await prepare({ default: "allow" }, undefined, echoFormat);
        expect(input.text).toBe("caption");
        expect(runExec).not.toHaveBeenCalled();
        prepared.applyApprovedText(requireInputText(input));
        await applyMediaUnderstanding({ ctx: prepared.ctx, cfg, processingMode: "audio-only" });
        expect(runExec).toHaveBeenCalledOnce();
        expect(prepared.ctx.BodyForAgent).toContain("policy-approved voice");
      });
    },
  );

  it("hands one policy-approved result to the same media context without retranscribing", async () => {
    await withEnvAsync({ PATH: "" }, async () => {
      const { prepared, input, cfg } = await prepare({
        default: "deny",
        rules: [
          {
            action: "allow",
            match: { keyPrefix: "agent:main:voice-policy" },
          },
        ],
      });
      const approvedText = requireInputText(input);
      expect(approvedText).toContain("policy-approved voice");
      expect(prepared.ctx.Transcript).toBe("policy-approved voice");
      expect(prepared.ctx.media?.[0]?.transcribed).toBe(true);
      expect(runExec).toHaveBeenCalledOnce();
      prepared.applyApprovedText(approvedText);
      await expect(transcribeAudioAttachments({ ctx: prepared.ctx, cfg })).resolves.toBeUndefined();
      expect(runExec).toHaveBeenCalledOnce();
      expect(prepared.ctx.BodyForAgent).toContain("machine-generated, untrusted");
    });
  });
});
