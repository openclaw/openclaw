import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { artifactsHandlers } from "./artifacts.js";
import { expectFields, expectOkPayload, requireNonEmptyString } from "./artifacts.test-support.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    visitSessionMessagesAsync: hoisted.visitSessionMessagesAsync,
  };
});

function historyRecoveryId(block: Record<string, unknown>): string {
  const [message] = projectChatDisplayMessages([{ role: "user", content: [block] }]);
  const projectedBlock = (message as { content?: Array<Record<string, unknown>> }).content?.[0];
  return requireNonEmptyString(projectedBlock?.artifactId, "expected history image recovery id");
}

async function downloadArtifact(artifactId: string) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await artifactsHandlers["artifacts.download"]?.({
    req: {
      type: "req",
      id: "history-image-download",
      method: "artifacts.download",
      params: {},
    },
    params: { sessionKey: "agent:main:main", artifactId },
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: {
      getRuntimeConfig: () => ({ agents: { entries: { main: { default: true } } } }),
    } as never,
  });
  return calls;
}

describe("history image artifact downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
  });

  it("downloads a legacy inline image through its projected recovery id", async () => {
    const block = {
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
    };
    const artifactId = historyRecoveryId(block);
    const message = { role: "user", content: [block], __openclaw: { seq: 7 } };
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(message, 1);
      return 1;
    });

    const calls = await downloadArtifact(artifactId);
    const payload = expectOkPayload(calls) as { artifact?: Record<string, unknown> };
    expectFields(payload, { encoding: "base64", data: block.data });
    expectFields(payload.artifact, {
      id: artifactId,
      type: "image",
      mimeType: "image/png",
      messageSeq: 7,
    });
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledOnce();
  });
});
