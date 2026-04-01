import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { handleEmailAction } from "./email-actions.js";

export function createEmailTool(): AnyAgentTool {
  return {
    label: "Email",
    name: "email",
    description: `Manage the VividWalls business email (kingler@vividwalls.co) via Microsoft Outlook/Exchange.

Actions:
- list: List/search inbox messages. Params: folder?, search?, filter?, top? (default 10), skip?
- read: Read full email content. Params: messageId (required)
- reply: Reply to an email. Params: messageId (required), body (required)
- send: Send a new email. Params: to (required, array), subject (required), body (required), cc?, bodyType? ("Text"|"HTML")
- forward: Forward an email. Params: messageId (required), to (required, array), comment?
- move: Move email to a folder. Params: messageId (required), folder (required, name or ID)
- categorize: Set categories/tags on email. Params: messageId (required), categories (required, array). Available: Urgent, Pending Response, Resolved, New Customer, VIP, Custom Order, Follow Up
- listFolders: List mail folders. Params: parentFolder? (name or ID, omit for top-level)

Inbox subfolders: Customer Inquiries, Orders & Shipping, Corporate & B2B, Returns & Refunds, Newsletters & Marketing`,
    parameters: Type.Object({
      action: Type.String({
        description:
          "The email action to perform: list, read, reply, send, forward, move, categorize, listFolders",
      }),
      messageId: Type.Optional(
        Type.String({ description: "Email message ID (from list results)" }),
      ),
      to: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "Recipient email address(es)",
        }),
      ),
      cc: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "CC recipient email address(es)",
        }),
      ),
      subject: Type.Optional(Type.String({ description: "Email subject" })),
      body: Type.Optional(Type.String({ description: "Email body content or reply text" })),
      bodyType: Type.Optional(
        Type.String({ description: "Body content type: Text (default) or HTML" }),
      ),
      comment: Type.Optional(Type.String({ description: "Comment when forwarding" })),
      folder: Type.Optional(
        Type.String({
          description: "Folder name or ID for list/move actions",
        }),
      ),
      parentFolder: Type.Optional(Type.String({ description: "Parent folder for listFolders" })),
      categories: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: "Category names to apply",
        }),
      ),
      search: Type.Optional(Type.String({ description: "Search query for list action" })),
      filter: Type.Optional(Type.String({ description: "OData filter for list action" })),
      top: Type.Optional(Type.Number({ description: "Max results to return (default 10)" })),
      skip: Type.Optional(Type.Number({ description: "Number of results to skip (pagination)" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      return handleEmailAction(params);
    },
  };
}
