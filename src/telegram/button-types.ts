export type TelegramButtonStyle = "danger" | "success" | "primary";

export type TelegramInlineButton =
  | { text: string; callback_data: string; url?: never; style?: TelegramButtonStyle }
  | { text: string; url: string; callback_data?: never; style?: TelegramButtonStyle };

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;
