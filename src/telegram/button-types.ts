export type TelegramButtonStyle = "danger" | "success" | "primary";

export type TelegramCallbackButton = {
  text: string;
  callback_data: string;
  style?: TelegramButtonStyle;
};

export type TelegramCopyTextButton = {
  text: string;
  copy_text: { text: string };
};

export type TelegramInlineButton = TelegramCallbackButton | TelegramCopyTextButton;

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;
