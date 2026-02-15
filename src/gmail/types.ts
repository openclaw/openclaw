export type GmailActionConfig = {
  read?: boolean;
  get?: boolean;
  search?: boolean;
  send?: boolean;
  draft?: boolean;
  triage?: boolean;
};

export type GmailAccountConfig = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  actions?: GmailActionConfig;
  accounts?: Record<string, GmailAccountConfig>;
};

export type GmailMessageSummary = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  threadId: string;
};

export type GmailFullMessage = {
  id: string;
  from: string;
  subject: string;
  body: string;
  attachments: GmailAttachment[];
};

export type GmailAttachment = {
  filename: string;
  mimeType: string;
};

export type GmailTriageResult = {
  urgent: GmailTriageItem[];
  needs_reply: GmailTriageItem[];
  informational: GmailTriageItem[];
  can_archive: GmailTriageItem[];
};

export type GmailTriageItem = {
  id: string;
  subject: string;
};
