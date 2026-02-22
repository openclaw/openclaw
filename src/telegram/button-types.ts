export type TelegramButtonStyle = "danger" | "success" | "primary";

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
  style?: TelegramButtonStyle;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;
