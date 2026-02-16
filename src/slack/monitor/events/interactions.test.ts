import { describe, expect, it, vi } from "vitest";
import { registerSlackInteractionEvents } from "./interactions.js";

const enqueueSystemEventMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

type RegisteredHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user: { id: string };
    channel?: { id?: string };
    message?: { ts?: string; text?: string; blocks?: unknown[] };
  };
  action: Record<string, unknown>;
  respond?: (payload: { text: string; response_type: string }) => Promise<void>;
}) => Promise<void>;

function createContext() {
  let handler: RegisteredHandler | null = null;
  const app = {
    action: vi.fn((_matcher: RegExp, next: RegisteredHandler) => {
      handler = next;
    }),
    client: {
      chat: {
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  const runtimeLog = vi.fn();
  const resolveSessionKey = vi.fn().mockReturnValue("agent:ops:slack:channel:C1");
  const ctx = {
    app,
    runtime: { log: runtimeLog },
    resolveSlackSystemEventSessionKey: resolveSessionKey,
  };
  return { ctx, app, runtimeLog, resolveSessionKey, getHandler: () => handler };
}

describe("registerSlackInteractionEvents", () => {
  it("enqueues structured events and updates button rows", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });

    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      respond,
      body: {
        user: { id: "U123" },
        channel: { id: "C1" },
        message: {
          ts: "100.200",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "verify_block",
              elements: [{ type: "button", action_id: "openclaw:verify" }],
            },
          ],
        },
      },
      action: {
        type: "button",
        action_id: "openclaw:verify",
        block_id: "verify_block",
        value: "approved",
        text: { type: "plain_text", text: "Approve" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    expect(eventText.startsWith("Slack interaction: ")).toBe(true);
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionId: string;
      actionType: string;
      value: string;
      userId: string;
      channelId: string;
      messageTs: string;
    };
    expect(payload).toMatchObject({
      actionId: "openclaw:verify",
      actionType: "button",
      value: "approved",
      userId: "U123",
      channelId: "C1",
      messageTs: "100.200",
    });
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("captures select values and skips chat.update for non-button actions", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      body: {
        user: { id: "U555" },
        channel: { id: "C1" },
        message: {
          ts: "111.222",
          blocks: [{ type: "actions", block_id: "select_block", elements: [] }],
        },
      },
      action: {
        type: "static_select",
        action_id: "openclaw:pick",
        block_id: "select_block",
        selected_option: {
          text: { type: "plain_text", text: "Canary" },
          value: "canary",
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType: string;
      selectedValues?: string[];
    };
    expect(payload.actionType).toBe("static_select");
    expect(payload.selectedValues).toEqual(["canary"]);
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });
});
