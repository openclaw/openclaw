import type { ChannelStructuredComponents } from "./channel-contract.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
  PluginInteractiveRegistration,
} from "./plugin-runtime.js";

export type DiscordComponentButtonStyle = "primary" | "secondary" | "success" | "danger" | "link";

export type DiscordComponentSelectType = "string" | "user" | "role" | "mentionable" | "channel";

export type DiscordComponentModalFieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "select"
  | "role-select"
  | "user-select";

export type DiscordComponentButtonSpec = {
  label: string;
  style?: DiscordComponentButtonStyle;
  url?: string;
  callbackData?: string;
  emoji?: {
    name: string;
    id?: string;
    animated?: boolean;
  };
  disabled?: boolean;
  allowedUsers?: string[];
};

export type DiscordComponentSelectOption = {
  label: string;
  value: string;
  description?: string;
  emoji?: {
    name: string;
    id?: string;
    animated?: boolean;
  };
  default?: boolean;
};

export type DiscordComponentSelectSpec = {
  type?: DiscordComponentSelectType;
  callbackData?: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  options?: DiscordComponentSelectOption[];
  allowedUsers?: string[];
};

export type DiscordComponentSectionAccessory =
  | {
      type: "thumbnail";
      url: string;
    }
  | {
      type: "button";
      button: DiscordComponentButtonSpec;
    };

type DiscordComponentSeparatorSpacing = "small" | "large" | 1 | 2;

export type DiscordComponentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "section";
      text?: string;
      texts?: string[];
      accessory?: DiscordComponentSectionAccessory;
    }
  | {
      type: "separator";
      spacing?: DiscordComponentSeparatorSpacing;
      divider?: boolean;
    }
  | {
      type: "actions";
      buttons?: DiscordComponentButtonSpec[];
      select?: DiscordComponentSelectSpec;
    }
  | {
      type: "media-gallery";
      items: Array<{ url: string; description?: string; spoiler?: boolean }>;
    }
  | {
      type: "file";
      file: `attachment://${string}`;
      spoiler?: boolean;
    };

export type DiscordModalFieldSpec = {
  type: DiscordComponentModalFieldType;
  name?: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: DiscordComponentSelectOption[];
  minValues?: number;
  maxValues?: number;
  minLength?: number;
  maxLength?: number;
  style?: "short" | "paragraph";
};

export type DiscordModalSpec = {
  title: string;
  callbackData?: string;
  triggerLabel?: string;
  triggerStyle?: DiscordComponentButtonStyle;
  allowedUsers?: string[];
  fields: DiscordModalFieldSpec[];
};

export type DiscordComponentMessageSpec = {
  text?: string;
  reusable?: boolean;
  container?: {
    accentColor?: string | number;
    spoiler?: boolean;
  };
  blocks?: DiscordComponentBlock[];
  modal?: DiscordModalSpec;
};

export type DiscordResponseComponents = ChannelStructuredComponents | DiscordComponentMessageSpec;

export type DiscordInteractiveHandlerContext = {
  channel: "discord";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  guildId?: string;
  senderId?: string;
  senderUsername?: string;
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction: {
    kind: "button" | "select" | "modal";
    data: string;
    namespace: string;
    payload: string;
    messageId?: string;
    values?: string[];
    fields?: Array<{ id: string; name: string; values: string[] }>;
  };
  respond: {
    acknowledge: () => Promise<void>;
    reply: (params: {
      text: string;
      ephemeral?: boolean;
      components?: DiscordResponseComponents;
    }) => Promise<void>;
    followUp: (params: {
      text: string;
      ephemeral?: boolean;
      components?: DiscordResponseComponents;
    }) => Promise<void>;
    editMessage: (params: {
      text?: string;
      components?: DiscordResponseComponents;
    }) => Promise<void>;
    clearComponents: (params?: { text?: string }) => Promise<void>;
  };
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

export type DiscordInteractiveHandlerRegistration = PluginInteractiveRegistration<
  DiscordInteractiveHandlerContext,
  "discord"
>;
