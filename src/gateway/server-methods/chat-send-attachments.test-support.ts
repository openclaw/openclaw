import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";

type Preparation = Parameters<typeof prepareChatSendAttachments>[0];
type Entry = Partial<NonNullable<Preparation["session"]["entry"]>>;
type AttachmentOptions = {
  params: ReturnType<typeof attachmentParams>;
  session: Pick<Preparation["session"], "cfg"> &
    Omit<Partial<Preparation["session"]>, "entry"> & { entry?: Entry };
  admission?: { initialSessionEntry?: Entry; admittedSessionEntry?: Entry };
  abortCleanup?: () => void;
  context?: Partial<Preparation["context"]>;
};

export function attachmentConfig(
  state: OpenClawTestState,
  {
    mode = "all",
    sandboxRoot = "sandboxes",
    mediaMaxMb,
    global = false,
  }: { mode?: "off" | "all"; sandboxRoot?: string; mediaMaxMb?: number; global?: boolean } = {},
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: global
        ? { main: { workspace: state.path("main") }, work: { workspace: state.path("work") } }
        : { main: { workspace: state.workspaceDir } },
      defaults: {
        skipBootstrap: true,
        ...(mediaMaxMb === undefined ? {} : { mediaMaxMb }),
        sandbox: {
          mode,
          scope: "agent",
          workspaceRoot: state.path(sandboxRoot),
          workspaceAccess: "none",
        },
      },
    },
    ...(global ? { session: { scope: "global" } } : {}),
  };
}

export function attachmentParams(
  idempotencyKey: string,
  fileName: string,
  content: string | Buffer,
  overrides: { agentId?: string; sessionKey?: string; message?: string } = {},
) {
  return {
    sessionKey: "agent:main:main",
    message: "read the file",
    idempotencyKey,
    attachments: [
      {
        fileName,
        mimeType: fileName.endsWith(".pdf") ? "application/pdf" : "text/plain",
        content: (typeof content === "string" ? Buffer.from(content) : content).toString("base64"),
      },
    ],
    ...overrides,
  };
}

export async function prepareAttachmentFixture(options: AttachmentOptions) {
  const { params, session, admission, abortCleanup } = options;
  const { context = { logGateway: createSubsystemLogger("test/media-owner") } } = options;
  const request = await normalizeChatSendRequest({ client: null, params });
  if (!request.ok) {
    throw new Error(request.error);
  }
  const controller = new AbortController();
  const respond = vi.fn();
  const result = await prepareChatSendAttachments({
    request: request.value,
    session: {
      sessionKey: params.sessionKey,
      agentId: params.agentId ?? "main",
      clientRunId: params.idempotencyKey,
      resolvedSessionModel: { provider: "fixture", model: "fixture" },
      ...session,
    },
    admission: {
      activeRunAbort: { controller, ...(abortCleanup ? { cleanup: abortCleanup } : {}) },
      assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
      cleanupAdmittedRun() {},
      ...admission,
    },
    context,
    respond,
  } as unknown as Preparation);
  return { result, respond };
}
