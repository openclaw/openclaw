import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import {
  createClient,
  createdSources,
  createTransport,
  getGoogleLiveToolOwnerState,
  installGoogleLiveTestFixture,
  startTransport,
} from "./google-live.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./shared.ts";

async function startActiveControlFixture(controlResult: Record<string, unknown>) {
  const client = createClient();
  vi.mocked(client["request"]).mockImplementation(async (method) => {
    if (method === "talk.client.toolCall") {
      return { runId: "run-1" };
    }
    if (method === "talk.client.steer") {
      return {
        ok: true,
        sessionKey: "main",
        active: true,
        speak: true,
        show: true,
        suppress: false,
        ...controlResult,
      };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const transport = await createTransport({}, client);
  const ws = await startTransport(transport);
  ws.emitContent({
    modelTurn: {
      parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
    },
  });
  await waitForFast(() => expect(createdSources).toHaveLength(1));
  ws.emitCalls({
    id: "call-1",
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    args: { question: "status?" },
  });
  await waitForFast(() =>
    expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
  );
  return { client, transport, ws };
}

async function sendControl(
  { client, ws }: Pick<Awaited<ReturnType<typeof startActiveControlFixture>>, "client" | "ws">,
  text: string,
) {
  ws.emitContent({ inputTranscription: { text, finished: true } });
  await waitForFast(() =>
    expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
  );
  expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
}

describe("GoogleLiveRealtimeTalkTransport control results", () => {
  installGoogleLiveTestFixture();

  it("surfaces Google Live tool-result send failures without an unhandled rejection", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "Still working.",
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = await createTransport({ onStatus, onTalkEvent }, client);

    const ws = await startTransport(transport);
    vi.spyOn(ws, "send").mockImplementation(() => {
      throw new Error("Google Live socket rejected the tool result");
    });
    ws.emitCalls({
      id: "call-control",
      name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
      args: { text: "status", mode: "status" },
    });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "Google Live socket rejected the tool result"),
    );
    expect(
      onTalkEvent.mock.calls.some(
        ([event]) =>
          (event.type === "tool.progress" || event.type === "tool.error") && event.final === true,
      ),
    ).toBe(false);
    expect(ws.readyState).toBe(3);
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-control")).toBe(false);
  });

  it.each([
    { mode: "status", text: "status", message: "OpenClaw is working in read (running)." },
    {
      mode: "steer",
      text: "actually focus on WebUI",
      message: "Got it. I steered the active run.",
    },
  ])(
    "speaks $mode acknowledgements after interrupting queued audio",
    async ({ mode, text, message }) => {
      const { client, transport, ws } = await startActiveControlFixture({
        mode,
        message,
        ...(mode === "steer" ? { queued: true } : {}),
      });
      await sendControl({ client, ws }, text);
      expect(ws.messages).toContainEqual({
        realtimeInput: { text: expect.stringContaining(`Status: "${message}"`) },
      });
      transport.stop();
    },
  );

  it("interrupts queued output when active-control cancel is suppressed in Google Live", async () => {
    const { client, transport, ws } = await startActiveControlFixture({
      mode: "cancel",
      aborted: true,
      message: "Cancelled the active OpenClaw run.",
    });

    await sendControl({ client, ws }, "cancel that");
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent.some((event) => event.clientContent)).toBe(false);
    transport.stop();
  });
});
