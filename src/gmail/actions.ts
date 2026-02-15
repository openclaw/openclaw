import type { GmailMessageSummary, GmailFullMessage, GmailTriageResult } from "./types.js";

export type ListOptions = {
  maxResults?: number;
  unreadOnly?: boolean;
  label?: string;
};

export type SendOptions = {
  to: string;
  subject: string;
  body: string;
  replyToMessageId?: string;
  cc?: string;
};

export type DraftOptions = {
  to: string;
  subject: string;
  body: string;
  replyToMessageId?: string;
};

export async function listGmailMessages(
  accountId: string,
  options: ListOptions,
): Promise<GmailMessageSummary[]> {
  // TODO: implement with Gmail API
  void accountId;
  void options;
  return [];
}

export async function getGmailMessage(
  accountId: string,
  messageId: string,
): Promise<GmailFullMessage> {
  // TODO: implement with Gmail API
  void accountId;
  void messageId;
  throw new Error("Not implemented");
}

export async function searchGmailMessages(
  accountId: string,
  query: string,
): Promise<GmailMessageSummary[]> {
  // TODO: implement with Gmail API
  void accountId;
  void query;
  return [];
}

export async function sendGmailMessage(
  accountId: string,
  options: SendOptions,
): Promise<{ id: string }> {
  // TODO: implement with Gmail API
  void accountId;
  void options;
  throw new Error("Not implemented");
}

export async function createGmailDraft(
  accountId: string,
  options: DraftOptions,
): Promise<{ id: string }> {
  // TODO: implement with Gmail API
  void accountId;
  void options;
  throw new Error("Not implemented");
}

export async function triageGmailMessages(accountId: string): Promise<GmailTriageResult> {
  // TODO: implement with rule-based classification
  void accountId;
  return {
    urgent: [],
    needs_reply: [],
    informational: [],
    can_archive: [],
  };
}
