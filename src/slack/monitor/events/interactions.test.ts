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
    team?: { id?: string };
    trigger_id?: string;
    response_url?: string;
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
    message?: { ts?: string; text?: string; blocks?: unknown[] };
  };
  action: Record<string, unknown>;
  respond?: (payload: { text: string; response_type: string }) => Promise<void>;
}) => Promise<void>;

type RegisteredViewHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user?: { id?: string };
    team?: { id?: string };
    view?: {
      id?: string;
      callback_id?: string;
      state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
    };
  };
}) => Promise<void>;

type RegisteredViewClosedHandler = (args: {
  ack: () => Promise<void>;
  body: {
    user?: { id?: string };
    team?: { id?: string };
    view?: {
      id?: string;
      callback_id?: string;
      private_metadata?: string;
      state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
    };
    is_cleared?: boolean;
  };
}) => Promise<void>;

function createContext() {
  let handler: RegisteredHandler | null = null;
  let viewHandler: RegisteredViewHandler | null = null;
  let viewClosedHandler: RegisteredViewClosedHandler | null = null;
  const app = {
    action: vi.fn((_matcher: RegExp, next: RegisteredHandler) => {
      handler = next;
    }),
    view: vi.fn((_matcher: RegExp, next: RegisteredViewHandler) => {
      viewHandler = next;
    }),
    viewClosed: vi.fn((_matcher: RegExp, next: RegisteredViewClosedHandler) => {
      viewClosedHandler = next;
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
  return {
    ctx,
    app,
    runtimeLog,
    resolveSessionKey,
    getHandler: () => handler,
    getViewHandler: () => viewHandler,
    getViewClosedHandler: () => viewClosedHandler,
  };
}

describe("registerSlackInteractionEvents", () => {
  it("enqueues structured events and updates button rows", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
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
        team: { id: "T9" },
        trigger_id: "123.trigger",
        response_url: "https://hooks.slack.test/response",
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "100.200", thread_ts: "100.100" },
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
      teamId?: string;
      triggerId?: string;
      responseUrl?: string;
      channelId: string;
      messageTs: string;
      threadTs?: string;
    };
    expect(payload).toMatchObject({
      actionId: "openclaw:verify",
      actionType: "button",
      value: "approved",
      userId: "U123",
      teamId: "T9",
      triggerId: "123.trigger",
      responseUrl: "https://hooks.slack.test/response",
      channelId: "C1",
      messageTs: "100.200",
      threadTs: "100.100",
    });
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C1",
      channelType: undefined,
    });
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("captures select values and updates action rows for non-button actions", async () => {
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
      selectedLabels?: string[];
    };
    expect(payload.actionType).toBe("static_select");
    expect(payload.selectedValues).toEqual(["canary"]);
    expect(payload.selectedLabels).toEqual(["Canary"]);
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "111.222",
        blocks: [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: ":white_check_mark: *Canary* selected" }],
          },
        ],
      }),
    );
  });

  it("falls back to container channel and message timestamps", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, app, getHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      body: {
        user: { id: "U111" },
        team: { id: "T111" },
        container: { channel_id: "C222", message_ts: "222.333", thread_ts: "222.111" },
      },
      action: {
        type: "button",
        action_id: "openclaw:container",
        block_id: "container_block",
        value: "ok",
        text: { type: "plain_text", text: "Container" },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "C222",
      channelType: undefined,
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      channelId?: string;
      messageTs?: string;
      threadTs?: string;
      teamId?: string;
    };
    expect(payload).toMatchObject({
      channelId: "C222",
      messageTs: "222.333",
      threadTs: "222.111",
      teamId: "T111",
    });
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });

  it("summarizes multi-select confirmations in updated message rows", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      body: {
        user: { id: "U222" },
        channel: { id: "C2" },
        message: {
          ts: "333.444",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "multi_block",
              elements: [{ type: "multi_static_select", action_id: "openclaw:multi" }],
            },
          ],
        },
      },
      action: {
        type: "multi_static_select",
        action_id: "openclaw:multi",
        block_id: "multi_block",
        selected_options: [
          { text: { type: "plain_text", text: "Alpha" }, value: "alpha" },
          { text: { type: "plain_text", text: "Beta" }, value: "beta" },
          { text: { type: "plain_text", text: "Gamma" }, value: "gamma" },
          { text: { type: "plain_text", text: "Delta" }, value: "delta" },
        ],
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledTimes(1);
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C2",
        ts: "333.444",
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: ":white_check_mark: *Alpha, Beta, Gamma +1* selected" },
            ],
          },
        ],
      }),
    );
  });

  it("captures expanded selection and temporal payload fields", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      body: {
        user: { id: "U321" },
        channel: { id: "C2" },
        message: { ts: "222.333" },
      },
      action: {
        type: "multi_conversations_select",
        action_id: "openclaw:route",
        selected_user: "U777",
        selected_users: ["U777", "U888"],
        selected_channel: "C777",
        selected_channels: ["C777", "C888"],
        selected_conversation: "G777",
        selected_conversations: ["G777", "G888"],
        selected_options: [
          { text: { type: "plain_text", text: "Alpha" }, value: "alpha" },
          { text: { type: "plain_text", text: "Alpha" }, value: "alpha" },
          { text: { type: "plain_text", text: "Beta" }, value: "beta" },
        ],
        selected_date: "2026-02-16",
        selected_time: "14:30",
        selected_date_time: 1_771_700_200,
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      actionType: string;
      selectedValues?: string[];
      selectedLabels?: string[];
      selectedDate?: string;
      selectedTime?: string;
      selectedDateTime?: number;
    };
    expect(payload.actionType).toBe("multi_conversations_select");
    expect(payload.selectedValues).toEqual([
      "alpha",
      "beta",
      "U777",
      "U888",
      "C777",
      "C888",
      "G777",
      "G888",
    ]);
    expect(payload.selectedLabels).toEqual(["Alpha", "Beta"]);
    expect(payload.selectedDate).toBe("2026-02-16");
    expect(payload.selectedTime).toBe("14:30");
    expect(payload.selectedDateTime).toBe(1_771_700_200);
  });

  it("captures modal submissions and enqueues view submission event", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, getViewHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        user: { id: "U777" },
        team: { id: "T1" },
        view: {
          id: "V123",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({ channelId: "D123", channelType: "im" }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: {
                    text: { type: "plain_text", text: "Production" },
                    value: "prod",
                  },
                },
              },
              notes_block: {
                notes_input: {
                  type: "plain_text_input",
                  value: "ship now",
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      actionId: string;
      callbackId: string;
      viewId: string;
      userId: string;
      routedChannelId?: string;
      inputs: Array<{ actionId: string; selectedValues?: string[]; inputValue?: string }>;
    };
    expect(payload).toMatchObject({
      interactionType: "view_submission",
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      viewId: "V123",
      userId: "U777",
      routedChannelId: "D123",
    });
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: "env_select", selectedValues: ["prod"] }),
        expect.objectContaining({ actionId: "notes_input", inputValue: "ship now" }),
      ]),
    );
  });

  it("captures modal input labels and picker values across block types", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        user: { id: "U444" },
        view: {
          id: "V400",
          callback_id: "openclaw:routing_form",
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: {
                    text: { type: "plain_text", text: "Production" },
                    value: "prod",
                  },
                },
              },
              assignee_block: {
                assignee_select: {
                  type: "users_select",
                  selected_user: "U900",
                },
              },
              channel_block: {
                channel_select: {
                  type: "channels_select",
                  selected_channel: "C900",
                },
              },
              convo_block: {
                convo_select: {
                  type: "conversations_select",
                  selected_conversation: "G900",
                },
              },
              date_block: {
                date_select: {
                  type: "datepicker",
                  selected_date: "2026-02-16",
                },
              },
              time_block: {
                time_select: {
                  type: "timepicker",
                  selected_time: "12:45",
                },
              },
              datetime_block: {
                datetime_select: {
                  type: "datetimepicker",
                  selected_date_time: 1_771_632_300,
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      inputs: Array<{
        actionId: string;
        selectedValues?: string[];
        selectedLabels?: string[];
        selectedDate?: string;
        selectedTime?: string;
        selectedDateTime?: number;
      }>;
    };
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "env_select",
          selectedValues: ["prod"],
          selectedLabels: ["Production"],
        }),
        expect.objectContaining({ actionId: "assignee_select", selectedValues: ["U900"] }),
        expect.objectContaining({ actionId: "channel_select", selectedValues: ["C900"] }),
        expect.objectContaining({ actionId: "convo_select", selectedValues: ["G900"] }),
        expect.objectContaining({ actionId: "date_select", selectedDate: "2026-02-16" }),
        expect.objectContaining({ actionId: "time_select", selectedTime: "12:45" }),
        expect.objectContaining({ actionId: "datetime_select", selectedDateTime: 1_771_632_300 }),
      ]),
    );
  });

  it("captures modal close events and enqueues view closed event", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, getViewClosedHandler, resolveSessionKey } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewClosedHandler = getViewClosedHandler();
    expect(viewClosedHandler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await viewClosedHandler!({
      ack,
      body: {
        user: { id: "U900" },
        team: { id: "T1" },
        is_cleared: true,
        view: {
          id: "V900",
          callback_id: "openclaw:deploy_form",
          private_metadata: JSON.stringify({ sessionKey: "agent:main:slack:channel:C99" }),
          state: {
            values: {
              env_block: {
                env_select: {
                  type: "static_select",
                  selected_option: {
                    text: { type: "plain_text", text: "Canary" },
                    value: "canary",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(resolveSessionKey).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [eventText, options] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey?: string },
    ];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      interactionType: string;
      actionId: string;
      callbackId: string;
      viewId: string;
      userId: string;
      isCleared: boolean;
      privateMetadata: string;
      inputs: Array<{ actionId: string; selectedValues?: string[] }>;
    };
    expect(payload).toMatchObject({
      interactionType: "view_closed",
      actionId: "view:openclaw:deploy_form",
      callbackId: "openclaw:deploy_form",
      viewId: "V900",
      userId: "U900",
      isCleared: true,
      privateMetadata: JSON.stringify({ sessionKey: "agent:main:slack:channel:C99" }),
    });
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: "env_select", selectedValues: ["canary"] }),
      ]),
    );
    expect(options.sessionKey).toBe("agent:main:slack:channel:C99");
  });
});
