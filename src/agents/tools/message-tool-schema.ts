import { Type, type TSchema } from "typebox";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../../channels/plugins/message-action-names.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { POLL_CREATION_PARAM_DEFS, SHARED_POLL_CREATION_PARAM_NAMES } from "../../poll-params.js";
import {
  channelTargetSchema,
  channelTargetsSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  stringEnum,
} from "../schema/typebox.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
type MessageToolSchemaOptions = {
  includeClawHub?: boolean;
  includePresentation: boolean;
  includeDeliveryPin: boolean;
  includeBestEffort: boolean;
  extraProperties?: Record<string, TSchema>;
};

const MESSAGE_TOOL_SEND_TEXT_DESCRIPTION =
  'Text for action="send". A send needs message or another send payload such as media, attachments, or presentation.';

function optionalStringSchema(description?: string) {
  return Type.Optional(Type.String(description === undefined ? undefined : { description }));
}

function optionalBooleanSchema(description?: string) {
  return Type.Optional(Type.Boolean(description === undefined ? undefined : { description }));
}

function buildRoutingSchema(options: { includeTeamId?: boolean }) {
  const props: Record<string, TSchema> = {
    channel: optionalStringSchema(),
    target: Type.Optional(channelTargetSchema()),
    targets: Type.Optional(channelTargetsSchema()),
    accountId: optionalStringSchema(),
    dryRun: optionalBooleanSchema(),
  };
  if (options.includeTeamId) {
    props.teamId = optionalStringSchema(
      "Team or workspace ID for channel-create, channel-info, channel-list, or conversation-open.",
    );
  }
  return props;
}

const presentationCommandActionSchema = Type.Object({
  type: Type.Literal("command"),
  command: Type.String(),
});

const presentationCallbackActionSchema = Type.Object({
  type: Type.Literal("callback"),
  value: Type.String(),
});

const presentationCommandOrCallbackActionSchema = Type.Union([
  presentationCommandActionSchema,
  presentationCallbackActionSchema,
]);

// Approval and question actions carry server-issued IDs and are runtime-authored
// only. The message tool exposes the remaining actions models may safely author.
const presentationButtonActionSchema = Type.Union([
  presentationCommandActionSchema,
  presentationCallbackActionSchema,
  Type.Object({
    type: Type.Literal("url"),
    url: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("web-app"),
    url: Type.String(),
    widgetId: optionalStringSchema(),
  }),
  Type.Object({
    type: Type.Literal("web-app"),
    url: optionalStringSchema(),
    widgetId: Type.String(),
  }),
]);

const presentationOptionSchema = Type.Object({
  label: Type.String(),
  action: Type.Optional(presentationCommandOrCallbackActionSchema),
  value: optionalStringSchema(),
});

const presentationButtonSchema = Type.Object({
  label: Type.String(),
  action: Type.Optional(presentationButtonActionSchema),
  value: optionalStringSchema(),
  url: optionalStringSchema(),
  webApp: Type.Optional(Type.Object({ url: Type.String() })),
  web_app: Type.Optional(Type.Object({ url: Type.String() })),
  disabled: optionalBooleanSchema(),
  reusable: optionalBooleanSchema(),
  style: Type.Optional(stringEnum(["primary", "secondary", "success", "danger"])),
});

const presentationChartSegmentSchema = Type.Object({
  label: Type.String(),
  value: Type.Number(),
});

const presentationChartSeriesSchema = Type.Object({
  name: Type.String(),
  values: Type.Array(Type.Number(), { minItems: 1 }),
});

// Keep this flat: some provider tool-schema validators reject an anyOf nested
// under presentation.blocks.items. Runtime normalization enforces block shapes.
const presentationBlockSchema = Type.Object({
  type: stringEnum(["text", "context", "divider", "buttons", "select", "chart", "table"]),
  text: optionalStringSchema(),
  buttons: Type.Optional(Type.Array(presentationButtonSchema)),
  placeholder: optionalStringSchema(),
  options: Type.Optional(Type.Array(presentationOptionSchema)),
  chartType: Type.Optional(stringEnum(["pie", "bar", "area", "line"])),
  title: optionalStringSchema(),
  segments: Type.Optional(Type.Array(presentationChartSegmentSchema, { minItems: 1 })),
  categories: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  series: Type.Optional(Type.Array(presentationChartSeriesSchema, { minItems: 1 })),
  xLabel: optionalStringSchema(),
  yLabel: optionalStringSchema(),
  caption: optionalStringSchema(),
  headers: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  rows: Type.Optional(
    Type.Array(
      Type.Array(Type.Unsafe<string | number>({ type: ["string", "number"] }), { minItems: 1 }),
      { minItems: 1 },
    ),
  ),
  rowHeaderColumnIndex: Type.Optional(Type.Integer({ minimum: 0 })),
});

const presentationMessageSchema = Type.Object(
  {
    title: optionalStringSchema(),
    tone: Type.Optional(stringEnum(["info", "success", "warning", "danger", "neutral"])),
    blocks: Type.Array(presentationBlockSchema),
  },
  {
    description: "Rich text/chart/table/button/select/context; unsupported degrades to text.",
  },
);

function buildSendSchema(options: MessageToolSchemaOptions) {
  const props: Record<string, TSchema> = {
    message: optionalStringSchema(MESSAGE_TOOL_SEND_TEXT_DESCRIPTION),
    effectId: optionalStringSchema("sendWithEffect id/name."),
    effect: optionalStringSchema("Alias for effectId."),
    media: optionalStringSchema("Media URL/path. data: use buffer."),
    filename: optionalStringSchema(),
    buffer: optionalStringSchema("Base64/data-URL attachment."),
    contentType: optionalStringSchema(),
    mimeType: optionalStringSchema(),
    caption: optionalStringSchema(),
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          type: Type.Optional(stringEnum(["image", "audio", "video", "file"])),
          media: optionalStringSchema(),
          name: optionalStringSchema(),
          mimeType: optionalStringSchema(),
        }),
        {
          description: "Attachments; each uses media.",
        },
      ),
    ),
    replyTo: optionalStringSchema(),
    threadId: optionalStringSchema(),
    asVoice: optionalBooleanSchema("Send audio as a voice note; combines with voiceText."),
    voiceText: optionalStringSchema("Text to synthesize; message remains visible."),
    voiceProvider: optionalStringSchema("Per-send speech provider override."),
    voiceId: optionalStringSchema("Per-send speech voice override."),
    silent: optionalBooleanSchema(),
    quoteText: optionalStringSchema("Telegram reply quote text."),
    gifPlayback: optionalBooleanSchema(),
    forceDocument: optionalBooleanSchema("Send media as document; no compression."),
    asDocument: optionalBooleanSchema("Alias for forceDocument."),
  };
  if (options.includeClawHub) {
    props.clawhub = Type.Optional(
      Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 160 }),
          kind: Type.Optional(stringEnum(["plugin", "skill"])),
        },
        {
          additionalProperties: false,
          description:
            "Official plugin/skill cards in current chat; user chooses install. Omit kind: plugins, then skills.",
        },
      ),
    );
  }
  if (options.includePresentation) {
    props.presentation = Type.Optional(presentationMessageSchema);
  }
  if (options.includeBestEffort) {
    props.bestEffort = optionalBooleanSchema(
      "Ordinary reply omit/true; false only requiring durable delivery.",
    );
  }
  if (options.includeDeliveryPin) {
    props.delivery = Type.Optional(
      Type.Object(
        {
          pin: Type.Optional(
            Type.Union([
              Type.Boolean(),
              Type.Object({
                enabled: Type.Boolean(),
                notify: optionalBooleanSchema(),
                required: optionalBooleanSchema(),
              }),
            ]),
          ),
        },
        {
          description: "Delivery prefs; pin when supported.",
        },
      ),
    );
  }
  return props;
}

const POLL_SCHEMA_BUILDERS = {
  string: optionalStringSchema,
  stringArray: () => Type.Optional(Type.Array(Type.String())),
  positiveInteger: optionalPositiveIntegerSchema,
  boolean: optionalBooleanSchema,
};

function buildPollSchema() {
  const props: Record<string, TSchema> = {
    pollId: optionalStringSchema(),
    pollOptionId: optionalStringSchema("Poll answer id."),
    pollOptionIds: Type.Optional(
      Type.Array(
        Type.String({
          description: "Poll answer ids for multiselect.",
        }),
      ),
    ),
    pollOptionIndex: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "1-based poll option number.",
      }),
    ),
    pollOptionIndexes: Type.Optional(
      Type.Array(
        Type.Integer({
          minimum: 1,
          description: "1-based poll option numbers for multiselect.",
        }),
      ),
    ),
  };
  for (const name of SHARED_POLL_CREATION_PARAM_NAMES) {
    const def = POLL_CREATION_PARAM_DEFS[name];
    if (!def) {
      continue;
    }
    props[name] = POLL_SCHEMA_BUILDERS[def.kind]();
  }
  return props;
}

const MESSAGE_SCHEMA_GROUPS: ReadonlyArray<{
  build: () => Record<string, TSchema>;
  actions: readonly ChannelMessageActionName[];
}> = [
  {
    build: () => ({
      messageId: optionalStringSchema(
        "Target read/react/edit/delete/pin/unpin id; reactions default current inbound.",
      ),
      // Intentional duplicate alias for tool-schema discoverability in LLMs.
      message_id: optionalStringSchema("snake_case alias of messageId; same defaults."),
      emoji: optionalStringSchema("Unicode emoji; channels may also support custom emoji."),
      remove: optionalBooleanSchema(),
      trackToolCalls: optionalBooleanSchema(
        "Use the reacted message for this turn's status reaction lifecycle.",
      ),
      track_tool_calls: optionalBooleanSchema("snake_case alias of trackToolCalls."),
      targetAuthor: optionalStringSchema(),
      targetAuthorUuid: optionalStringSchema(),
      groupId: optionalStringSchema(),
    }),
    actions: [
      "react",
      "reactions",
      "read",
      "edit",
      "delete",
      "unsend",
      "pin",
      "unpin",
      "reply",
      "thread-create",
    ],
  },
  {
    build: () => ({
      limit: optionalPositiveIntegerSchema({ description: "Maximum number of results to return." }),
      pageSize: optionalPositiveIntegerSchema(),
      pageToken: optionalStringSchema(),
      before: optionalStringSchema(),
      after: optionalStringSchema(),
      around: optionalStringSchema(),
      fromMe: optionalBooleanSchema(),
      includeArchived: optionalBooleanSchema(),
    }),
    actions: [
      "read",
      "reactions",
      "search",
      "thread-list",
      "channel-list",
      "channel-info",
      "list-pins",
      "event-list",
      "sticker-search",
      "emoji-list",
    ],
  },
  {
    // Include only actions whose handlers read query. Discord event-list historically
    // advertised query through the event schema but ignores it at dispatch.
    build: () => ({ query: optionalStringSchema() }),
    actions: ["search", "sticker-search", "channel-list"],
  },
  { build: buildPollSchema, actions: ["poll", "poll-vote"] },
  {
    build: () => ({
      channelId: optionalStringSchema("Channel id filter."),
      chatId: optionalStringSchema("Chat id for chat metadata."),
      channelIds: Type.Optional(Type.Array(Type.String({ description: "Channel id filter." }))),
      memberId: optionalStringSchema(),
      memberIdType: optionalStringSchema(),
      guildId: optionalStringSchema(),
      userId: optionalStringSchema(
        "member-info/moderation/participant user id; member-info uses userId, not target.",
      ),
      openId: optionalStringSchema(),
      unionId: optionalStringSchema(),
      authorId: optionalStringSchema(),
      authorIds: Type.Optional(Type.Array(Type.String())),
      roleId: optionalStringSchema(),
      roleIds: Type.Optional(Type.Array(Type.String())),
      participant: optionalStringSchema(),
      includeMembers: optionalBooleanSchema(),
      members: optionalBooleanSchema(),
      scope: optionalStringSchema(),
      kind: optionalStringSchema(),
    }),
    actions: [
      "search",
      "thread-list",
      "thread-create",
      "thread-reply",
      "channel-info",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "topic-create",
      "topic-edit",
      "permissions",
      "member-info",
      "role-info",
      "role-add",
      "role-remove",
      "addParticipant",
      "removeParticipant",
      "renameGroup",
      "setGroupIcon",
      "leaveGroup",
      "event-create",
      "event-list",
      "timeout",
      "kick",
      "ban",
      "emoji-list",
      "emoji-upload",
      "sticker-upload",
      "voice-status",
      "download-file",
    ],
  },
  {
    build: () => ({
      fileId: optionalStringSchema(),
      emojiName: optionalStringSchema("Name for an uploaded custom emoji."),
      stickerId: Type.Optional(Type.Array(Type.String())),
      stickerName: optionalStringSchema(),
      stickerDesc: optionalStringSchema(),
      stickerTags: optionalStringSchema(),
    }),
    actions: [
      "sticker",
      "sticker-search",
      "sticker-upload",
      "emoji-list",
      "emoji-upload",
      "download-file",
      "upload-file",
    ],
  },
  {
    build: () => ({
      threadName: optionalStringSchema(),
      autoArchiveMin: optionalPositiveIntegerSchema(),
      appliedTags: Type.Optional(Type.Array(Type.String())),
    }),
    actions: ["thread-create", "thread-list", "thread-reply"],
  },
  {
    build: () => ({
      eventName: optionalStringSchema(),
      eventType: optionalStringSchema(),
      startTime: optionalStringSchema(),
      endTime: optionalStringSchema(),
      desc: optionalStringSchema(),
      location: optionalStringSchema(),
      image: optionalStringSchema("Event cover image URL/path."),
    }),
    actions: ["event-create", "event-list"],
  },
  {
    build: () => ({
      reason: optionalStringSchema(),
      deleteDays: optionalNonNegativeIntegerSchema({ maximum: 7 }),
      durationMin: optionalNonNegativeIntegerSchema(),
      until: optionalStringSchema(),
    }),
    actions: ["timeout", "kick", "ban", "delete", "unsend"],
  },
  {
    // Keep every action that reads channel-management fields here; omission hides valid params.
    build: () => ({
      name: optionalStringSchema(),
      channelType: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Numeric channel type; avoids schema type collision.",
        }),
      ),
      parentId: optionalStringSchema(),
      topic: optionalStringSchema(),
      position: optionalNonNegativeIntegerSchema(),
      nsfw: optionalBooleanSchema(),
      rateLimitPerUser: optionalNonNegativeIntegerSchema(),
      categoryId: optionalStringSchema(),
      clearParent: optionalBooleanSchema("Clear parent/category when supported."),
    }),
    actions: [
      "channel-create",
      "channel-edit",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "topic-create",
      "topic-edit",
      "renameGroup",
      "setGroupIcon",
    ],
  },
  {
    build: () => ({
      activityType: optionalStringSchema(
        "Activity type: playing, streaming, listening, watching, competing, custom.",
      ),
      activityName: optionalStringSchema("Activity name shown in sidebar; ignored for custom."),
      activityUrl: optionalStringSchema("Streaming URL; streaming type only."),
      activityState: optionalStringSchema("State text; custom type uses as status text."),
      status: optionalStringSchema("Bot status: online, dnd, idle, invisible."),
    }),
    actions: ["set-presence", "set-profile", "voice-status"],
  },
];

export function buildMessageToolSchemaFromActions(
  actions: readonly string[],
  options: MessageToolSchemaOptions,
) {
  const schemaOptions = {
    ...options,
    includeTeamId: actions.some(
      (action) =>
        action === "channel-info" || action === "channel-list" || action === "conversation-open",
    ),
  };
  // Keep one flat object: provider adapters reject per-action anyOf/oneOf schemas.
  // Groups prune unavailable fields; runtime still validates each action payload.
  const properties: Record<string, TSchema> = {
    ...buildRoutingSchema(schemaOptions),
    ...buildSendSchema(schemaOptions),
    ...gatewayCallOptionSchemaProperties(),
  };
  const activeActions = new Set(actions);
  for (const group of MESSAGE_SCHEMA_GROUPS) {
    if (group.actions.some((action) => activeActions.has(action))) {
      Object.assign(properties, group.build());
    }
  }
  return Type.Object({
    action: stringEnum(actions, {
      description:
        'Select one action. For action="send", provide message or another send payload; fields for other actions do not count as send content.',
    }),
    ...properties,
    ...schemaOptions.extraProperties,
  });
}

export const MessageToolSchema = buildMessageToolSchemaFromActions(CHANNEL_MESSAGE_ACTION_NAMES, {
  includePresentation: true,
  includeDeliveryPin: true,
  includeBestEffort: false,
});
