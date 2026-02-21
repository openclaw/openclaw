export type WatiSendResult = { messageId: string; chatId: string };

export type WatiTemplateParams = {
  templateName: string;
  parameters: Array<{ name: string; value: string }>;
};
