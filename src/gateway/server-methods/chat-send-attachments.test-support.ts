import { vi } from "vitest";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";

type Preparation = Parameters<typeof prepareChatSendAttachments>[0];
type Entry = Partial<NonNullable<Preparation["session"]["entry"]>>;

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

export async function prepareAttachmentFixture({
  params,
  session,
  admission,
  abortCleanup,
  context = { logGateway: createSubsystemLogger("test/media-owner") },
}: {
  params: ReturnType<typeof attachmentParams>;
  session: Pick<Preparation["session"], "cfg"> &
    Omit<Partial<Preparation["session"]>, "entry"> & { entry?: Entry };
  admission?: { initialSessionEntry?: Entry; admittedSessionEntry?: Entry };
  abortCleanup?: () => void;
  context?: Partial<Preparation["context"]>;
}) {
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
