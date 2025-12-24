export type MsgContext = {
  Body?: string;
  From?: string;
  To?: string;
  MessageSid?: string;
  ReplyToId?: string;
  ReplyToBody?: string;
  ReplyToSender?: string;
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  Transcript?: string;
  ChatType?: string;
  GroupSubject?: string;
  GroupMembers?: string;
  SenderName?: string;
  SenderE164?: string;
  Surface?: string;
  WasMentioned?: boolean;
};

export type TemplateContext = MsgContext & {
  BodyStripped?: string;
  SessionId?: string;
  IsNewSession?: string;
};

// Simple {{Placeholder}} interpolation using inbound message context.
export function applyTemplate(str: string | undefined, ctx: TemplateContext) {
  if (!str) return "";
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = ctx[key as keyof TemplateContext];
    return value == null ? "" : String(value);
  });
}
