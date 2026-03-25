import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  ToolInputError,
} from "./common.js";
import {
  categorizeEmail,
  forwardEmail,
  listChildFolders,
  listEmails,
  listFolders,
  markAsRead,
  moveEmail,
  readEmail,
  replyToEmail,
  sendEmail,
} from "./email-graph-client.js";

export async function handleEmailAction(
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });

  switch (action) {
    case "list": {
      const folder = readStringParam(params, "folder");
      const search = readStringParam(params, "search");
      const filter = readStringParam(params, "filter");
      const top = readNumberParam(params, "top", { integer: true }) ?? 10;
      const skip = readNumberParam(params, "skip", { integer: true });

      let folderId = folder;
      if (folder && !folder.startsWith("AAMk")) {
        folderId = await resolveFolderIdByName(folder);
      }

      const result = await listEmails({ folderId, top, skip, search, filter });
      const summary = result.messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from?.emailAddress?.address,
        fromName: m.from?.emailAddress?.name,
        date: m.receivedDateTime,
        isRead: m.isRead,
        preview: m.bodyPreview?.slice(0, 150),
        categories: m.categories,
        hasAttachments: m.hasAttachments,
      }));
      return jsonResult({
        ok: true,
        count: summary.length,
        totalCount: result.totalCount,
        messages: summary,
      });
    }

    case "read": {
      const messageId = readStringParam(params, "messageId", { required: true });
      const message = await readEmail(messageId);
      if (!message.isRead) {
        await markAsRead(messageId, true).catch(() => {});
      }
      const bodyText =
        message.body?.contentType === "HTML"
          ? stripHtml(message.body.content)
          : (message.body?.content ?? message.bodyPreview);
      return jsonResult({
        ok: true,
        message: {
          id: message.id,
          subject: message.subject,
          from: message.from?.emailAddress?.address,
          fromName: message.from?.emailAddress?.name,
          to: message.toRecipients?.map((r) => r.emailAddress.address),
          date: message.receivedDateTime,
          body: bodyText,
          categories: message.categories,
          hasAttachments: message.hasAttachments,
        },
      });
    }

    case "reply": {
      const messageId = readStringParam(params, "messageId", { required: true });
      const comment = readStringParam(params, "body", { required: true });
      await replyToEmail(messageId, comment);
      return jsonResult({ ok: true, action: "replied", messageId });
    }

    case "send": {
      const to = readStringArrayParam(params, "to", { required: true });
      const subject = readStringParam(params, "subject", { required: true });
      const body = readStringParam(params, "body", { required: true });
      const cc = readStringArrayParam(params, "cc");
      const bodyType =
        readStringParam(params, "bodyType") === "HTML" ? ("HTML" as const) : ("Text" as const);
      await sendEmail({ to, cc, subject, body, bodyType });
      return jsonResult({ ok: true, action: "sent", to, subject });
    }

    case "forward": {
      const messageId = readStringParam(params, "messageId", { required: true });
      const to = readStringArrayParam(params, "to", { required: true });
      const comment = readStringParam(params, "comment");
      await forwardEmail(messageId, to, comment);
      return jsonResult({ ok: true, action: "forwarded", messageId, to });
    }

    case "move": {
      const messageId = readStringParam(params, "messageId", { required: true });
      const folder = readStringParam(params, "folder", { required: true });
      let folderId = folder;
      if (!folder.startsWith("AAMk")) {
        folderId = await resolveFolderIdByName(folder);
        if (!folderId) {
          throw new ToolInputError(
            `Folder "${folder}" not found. Use email action="listFolders" to see available folders.`,
          );
        }
      }
      await moveEmail(messageId, folderId);
      return jsonResult({ ok: true, action: "moved", messageId, folder });
    }

    case "categorize": {
      const messageId = readStringParam(params, "messageId", { required: true });
      const categories = readStringArrayParam(params, "categories", { required: true });
      const result = await categorizeEmail(messageId, categories);
      return jsonResult({
        ok: true,
        action: "categorized",
        messageId,
        categories: result.categories,
      });
    }

    case "listFolders": {
      const parentFolder = readStringParam(params, "parentFolder");
      let folders;
      if (parentFolder) {
        let parentId = parentFolder;
        if (!parentFolder.startsWith("AAMk")) {
          parentId = await resolveFolderIdByName(parentFolder);
          if (!parentId) {
            throw new ToolInputError(`Parent folder "${parentFolder}" not found.`);
          }
        }
        folders = await listChildFolders(parentId);
      } else {
        folders = await listFolders();
      }
      return jsonResult({
        ok: true,
        folders: folders.map((f) => ({
          id: f.id,
          name: f.displayName,
          total: f.totalItemCount,
          unread: f.unreadItemCount,
        })),
      });
    }

    default:
      throw new ToolInputError(
        `Unknown email action: "${action}". Valid actions: list, read, reply, send, forward, move, categorize, listFolders`,
      );
  }
}

async function resolveFolderIdByName(name: string): Promise<string> {
  const allFolders = await listFolders();
  const match = allFolders.find((f) => f.displayName.toLowerCase() === name.toLowerCase());
  if (match) {
    return match.id;
  }

  const inbox = allFolders.find((f) => f.displayName.toLowerCase() === "inbox");
  if (inbox) {
    const children = await listChildFolders(inbox.id);
    const childMatch = children.find((f) => f.displayName.toLowerCase() === name.toLowerCase());
    if (childMatch) {
      return childMatch.id;
    }
  }

  throw new ToolInputError(
    `Folder "${name}" not found. Use email action="listFolders" to see available folders.`,
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
