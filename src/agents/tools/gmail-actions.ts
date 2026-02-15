import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { listGmailAccountIds } from "../../gmail/accounts.js";
import {
  listGmailMessages,
  getGmailMessage,
  searchGmailMessages,
  sendGmailMessage,
  createGmailDraft,
  triageGmailMessages,
} from "../../gmail/actions.js";
import { createActionGate, jsonResult, readNumberParam, readStringParam } from "./common.js";

type GmailActionConfig = {
  read?: boolean;
  get?: boolean;
  search?: boolean;
  send?: boolean;
  draft?: boolean;
  triage?: boolean;
};

function getGmailActions(cfg: OpenClawConfig): GmailActionConfig | undefined {
  const gmail = (cfg.channels as Record<string, unknown> | undefined)?.gmail as
    | { actions?: GmailActionConfig }
    | undefined;
  return gmail?.actions;
}

function resolveAccountId(params: Record<string, unknown>): string {
  return readStringParam(params, "accountId") ?? "default";
}

async function handleRead(
  params: Record<string, unknown>,
  accountId: string,
): Promise<AgentToolResult<unknown>> {
  const count = readNumberParam(params, "count", { integer: true });
  const label = readStringParam(params, "label");
  const unreadOnlyRaw = params.unreadOnly;
  const unreadOnly = typeof unreadOnlyRaw === "boolean" ? unreadOnlyRaw : true;

  const messages = await listGmailMessages(accountId, {
    maxResults: count ?? undefined,
    unreadOnly,
    label: label ?? undefined,
  });

  return jsonResult({ ok: true, messages });
}

async function handleGet(
  params: Record<string, unknown>,
  accountId: string,
): Promise<AgentToolResult<unknown>> {
  const messageId = readStringParam(params, "messageId", { required: true });
  const message = await getGmailMessage(accountId, messageId);
  return jsonResult({ ok: true, message });
}

async function handleSearch(
  params: Record<string, unknown>,
  accountId: string,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const query = readStringParam(params, "query", { required: true });

  if (accountId === "all") {
    const accountIds = listGmailAccountIds(cfg);
    const allResults = await Promise.all(accountIds.map((id) => searchGmailMessages(id, query)));
    const results = allResults.flat();
    return jsonResult({ ok: true, results });
  }

  const results = await searchGmailMessages(accountId, query);
  return jsonResult({ ok: true, results });
}

async function handleSend(
  params: Record<string, unknown>,
  accountId: string,
): Promise<AgentToolResult<unknown>> {
  const to = readStringParam(params, "to", { required: true });
  const subject = readStringParam(params, "subject", { required: true });
  const body = readStringParam(params, "body", { required: true });
  const replyToMessageId = readStringParam(params, "replyToMessageId");
  const cc = readStringParam(params, "cc");

  const result = await sendGmailMessage(accountId, {
    to,
    subject,
    body,
    replyToMessageId: replyToMessageId ?? undefined,
    cc: cc ?? undefined,
  });

  return jsonResult({ ok: true, messageId: result.id });
}

async function handleDraft(
  params: Record<string, unknown>,
  accountId: string,
): Promise<AgentToolResult<unknown>> {
  const to = readStringParam(params, "to", { required: true });
  const subject = readStringParam(params, "subject", { required: true });
  const body = readStringParam(params, "body", { required: true });
  const replyToMessageId = readStringParam(params, "replyToMessageId");

  const result = await createGmailDraft(accountId, {
    to,
    subject,
    body,
    replyToMessageId: replyToMessageId ?? undefined,
  });

  return jsonResult({ ok: true, draftId: result.id });
}

async function handleTriage(
  accountId: string,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  if (accountId === "all") {
    const accountIds = listGmailAccountIds(cfg);
    const allResults = await Promise.all(accountIds.map((id) => triageGmailMessages(id)));
    const merged = {
      urgent: allResults.flatMap((r) => r.urgent),
      needs_reply: allResults.flatMap((r) => r.needs_reply),
      informational: allResults.flatMap((r) => r.informational),
      can_archive: allResults.flatMap((r) => r.can_archive),
    };
    return jsonResult({ ok: true, triage: merged });
  }

  const triage = await triageGmailMessages(accountId);
  return jsonResult({ ok: true, triage });
}

export async function handleGmailAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const actionConfig = getGmailActions(cfg);
  const isActionEnabled = createActionGate(actionConfig);
  const accountId = resolveAccountId(params);

  if (action === "read") {
    if (!isActionEnabled("read")) {
      throw new Error("Gmail read is disabled.");
    }
    return await handleRead(params, accountId);
  }

  if (action === "get") {
    if (!isActionEnabled("get")) {
      throw new Error("Gmail get is disabled.");
    }
    return await handleGet(params, accountId);
  }

  if (action === "search") {
    if (!isActionEnabled("search")) {
      throw new Error("Gmail search is disabled.");
    }
    return await handleSearch(params, accountId, cfg);
  }

  if (action === "send") {
    if (!isActionEnabled("send")) {
      throw new Error("Gmail send is disabled.");
    }
    return await handleSend(params, accountId);
  }

  if (action === "draft") {
    if (!isActionEnabled("draft")) {
      throw new Error("Gmail draft is disabled.");
    }
    return await handleDraft(params, accountId);
  }

  if (action === "triage") {
    if (!isActionEnabled("triage")) {
      throw new Error("Gmail triage is disabled.");
    }
    return await handleTriage(accountId, cfg);
  }

  throw new Error(`Unknown action: ${action}`);
}
