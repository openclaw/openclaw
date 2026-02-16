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
            elements: [{ type: "mrkdwn", text: ":white_check_mark: *Canary* selected by <@U555>" }],
          },
        ],
      }),
    );
  });

  it("escapes mrkdwn characters in confirmation labels", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      body: {
        user: { id: "U556" },
        channel: { id: "C1" },
        message: {
          ts: "111.223",
          blocks: [{ type: "actions", block_id: "select_block", elements: [] }],
        },
      },
      action: {
        type: "static_select",
        action_id: "openclaw:pick",
        block_id: "select_block",
        selected_option: {
          text: { type: "plain_text", text: "Canary_*`~<&>" },
          value: "canary",
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(app.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "111.223",
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: ":white_check_mark: *Canary\\_\\*\\`\\~&lt;&amp;&gt;* selected by <@U556>",
              },
            ],
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
              {
                type: "mrkdwn",
                text: ":white_check_mark: *Alpha, Beta, Gamma +1* selected by <@U222>",
              },
            ],
          },
        ],
      }),
    );
  });

  it("renders date/time/datetime picker selections in confirmation rows", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, app, getHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const handler = getHandler();
    expect(handler).toBeTruthy();

    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      body: {
        user: { id: "U333" },
        channel: { id: "C3" },
        message: {
          ts: "555.666",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "date_block",
              elements: [{ type: "datepicker", action_id: "openclaw:date" }],
            },
            {
              type: "actions",
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
            },
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
      },
      action: {
        type: "datepicker",
        action_id: "openclaw:date",
        block_id: "date_block",
        selected_date: "2026-02-16",
      },
    });

    await handler!({
      ack,
      body: {
        user: { id: "U333" },
        channel: { id: "C3" },
        message: {
          ts: "555.667",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "time_block",
              elements: [{ type: "timepicker", action_id: "openclaw:time" }],
            },
          ],
        },
      },
      action: {
        type: "timepicker",
        action_id: "openclaw:time",
        block_id: "time_block",
        selected_time: "14:30",
      },
    });

    await handler!({
      ack,
      body: {
        user: { id: "U333" },
        channel: { id: "C3" },
        message: {
          ts: "555.668",
          text: "fallback",
          blocks: [
            {
              type: "actions",
              block_id: "datetime_block",
              elements: [{ type: "datetimepicker", action_id: "openclaw:datetime" }],
            },
          ],
        },
      },
      action: {
        type: "datetimepicker",
        action_id: "openclaw:datetime",
        block_id: "datetime_block",
        selected_date_time: selectedDateTimeEpoch,
      },
    });

    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C3",
        ts: "555.666",
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: ":white_check_mark: *2026-02-16* selected by <@U333>" },
            ],
          },
          expect.anything(),
          expect.anything(),
        ],
      }),
    );
    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "C3",
        ts: "555.667",
        blocks: [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: ":white_check_mark: *14:30* selected by <@U333>" }],
          },
        ],
      }),
    );
    expect(app.client.chat.update).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        channel: "C3",
        ts: "555.668",
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `:white_check_mark: *${new Date(
                  selectedDateTimeEpoch * 1000,
                ).toISOString()}* selected by <@U333>`,
              },
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
      selectedUsers?: string[];
      selectedChannels?: string[];
      selectedConversations?: string[];
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
    expect(payload.selectedUsers).toEqual(["U777", "U888"]);
    expect(payload.selectedChannels).toEqual(["C777", "C888"]);
    expect(payload.selectedConversations).toEqual(["G777", "G888"]);
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
              radio_block: {
                radio_select: {
                  type: "radio_buttons",
                  selected_option: {
                    text: { type: "plain_text", text: "Blue" },
                    value: "blue",
                  },
                },
              },
              checks_block: {
                checks_select: {
                  type: "checkboxes",
                  selected_options: [
                    { text: { type: "plain_text", text: "A" }, value: "a" },
                    { text: { type: "plain_text", text: "B" }, value: "b" },
                  ],
                },
              },
              number_block: {
                number_input: {
                  type: "number_input",
                  value: "42.5",
                },
              },
              email_block: {
                email_input: {
                  type: "email_text_input",
                  value: "team@openclaw.ai",
                },
              },
              url_block: {
                url_input: {
                  type: "url_text_input",
                  value: "https://docs.openclaw.ai",
                },
              },
              richtext_block: {
                richtext_input: {
                  type: "rich_text_input",
                  rich_text_value: {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [
                          { type: "text", text: "Ship this now" },
                          { type: "text", text: "with canary metrics" },
                        ],
                      },
                    ],
                  },
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
        inputKind?: string;
        selectedValues?: string[];
        selectedUsers?: string[];
        selectedChannels?: string[];
        selectedConversations?: string[];
        selectedLabels?: string[];
        selectedDate?: string;
        selectedTime?: string;
        selectedDateTime?: number;
        inputNumber?: number;
        inputEmail?: string;
        inputUrl?: string;
        richTextValue?: unknown;
        richTextPreview?: string;
      }>;
    };
    expect(payload.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "env_select",
          selectedValues: ["prod"],
          selectedLabels: ["Production"],
        }),
        expect.objectContaining({
          actionId: "assignee_select",
          selectedValues: ["U900"],
          selectedUsers: ["U900"],
        }),
        expect.objectContaining({
          actionId: "channel_select",
          selectedValues: ["C900"],
          selectedChannels: ["C900"],
        }),
        expect.objectContaining({
          actionId: "convo_select",
          selectedValues: ["G900"],
          selectedConversations: ["G900"],
        }),
        expect.objectContaining({ actionId: "date_select", selectedDate: "2026-02-16" }),
        expect.objectContaining({ actionId: "time_select", selectedTime: "12:45" }),
        expect.objectContaining({ actionId: "datetime_select", selectedDateTime: 1_771_632_300 }),
        expect.objectContaining({
          actionId: "radio_select",
          selectedValues: ["blue"],
          selectedLabels: ["Blue"],
        }),
        expect.objectContaining({
          actionId: "checks_select",
          selectedValues: ["a", "b"],
          selectedLabels: ["A", "B"],
        }),
        expect.objectContaining({
          actionId: "number_input",
          inputKind: "number",
          inputNumber: 42.5,
        }),
        expect.objectContaining({
          actionId: "email_input",
          inputKind: "email",
          inputEmail: "team@openclaw.ai",
        }),
        expect.objectContaining({
          actionId: "url_input",
          inputKind: "url",
          inputUrl: "https://docs.openclaw.ai/",
        }),
        expect.objectContaining({
          actionId: "richtext_input",
          inputKind: "rich_text",
          richTextPreview: "Ship this now with canary metrics",
          richTextValue: {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Ship this now" },
                  { type: "text", text: "with canary metrics" },
                ],
              },
            ],
          },
        }),
      ]),
    );
  });

  it("truncates rich text preview to keep payload summaries compact", async () => {
    enqueueSystemEventMock.mockReset();
    const { ctx, getViewHandler } = createContext();
    registerSlackInteractionEvents({ ctx: ctx as never });
    const viewHandler = getViewHandler();
    expect(viewHandler).toBeTruthy();

    const longText = "deploy ".repeat(40).trim();
    const ack = vi.fn().mockResolvedValue(undefined);
    await viewHandler!({
      ack,
      body: {
        user: { id: "U555" },
        view: {
          id: "V555",
          callback_id: "openclaw:long_richtext",
          state: {
            values: {
              richtext_block: {
                richtext_input: {
                  type: "rich_text_input",
                  rich_text_value: {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [{ type: "text", text: longText }],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    const [eventText] = enqueueSystemEventMock.mock.calls[0] as [string];
    const payload = JSON.parse(eventText.replace("Slack interaction: ", "")) as {
      inputs: Array<{ actionId: string; richTextPreview?: string }>;
    };
    const richInput = payload.inputs.find((input) => input.actionId === "richtext_input");
    expect(richInput?.richTextPreview).toBeTruthy();
    expect((richInput?.richTextPreview ?? "").length).toBeLessThanOrEqual(120);
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
const selectedDateTimeEpoch = 1_771_632_300;
