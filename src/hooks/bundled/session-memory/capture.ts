import { resolveSessionTranscriptReadFence } from "../../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../../../config/sessions/session-transcript-read-source.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveHookConfig } from "../../config.js";
import { formatHookErrorForLog } from "../../fire-and-forget.js";
import type { SessionMemoryTranscript } from "./capture.types.js";
import { readSessionMemoryCapture } from "./capture.worker.js";

export type { SessionMemoryTranscript } from "./capture.types.js";

/** Capture while the caller still owns the departing session's active window. */
export async function captureSessionMemoryTranscript(
  scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string },
  cfg: OpenClawConfig | undefined,
): Promise<SessionMemoryTranscript> {
  const hookConfig = resolveHookConfig(cfg, "session-memory");
  const messageCount =
    typeof hookConfig?.messages === "number" && hookConfig.messages > 0 ? hookConfig.messages : 15;
  try {
    return await withSessionTranscriptReadSource(
      scope,
      (captured) => readSessionMemoryCapture({ scope: captured, messageCount }),
      async (source) => {
        const reader = source.preparedReads ?? source.owner;
        const transcript = await reader.readSessionMemoryCapture({
          scope: source.scope,
          resolved: source.resolved,
          messageCount,
          admission: resolveSessionTranscriptReadFence(source.resolved),
          expectedIdentity: source.expectedIdentity,
        });
        source.assertCurrent();
        return transcript;
      },
    );
  } catch (error) {
    return { status: "unavailable", reason: formatHookErrorForLog(error) };
  }
}
