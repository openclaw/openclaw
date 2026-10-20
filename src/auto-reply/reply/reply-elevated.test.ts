import { expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

const sender: MsgContext = {
  Provider: "whatsapp",
  Surface: "whatsapp",
  SenderId: "+15550001111",
  From: "whatsapp:+15550001111",
  SenderE164: "+15550001111",
  To: "+15559990000",
};

function expectAllowFromDecision(params: {
  allowFrom: string[];
  ctx?: Partial<MsgContext>;
  allowed: boolean;
}) {
  const result = resolveElevatedPermissions({
    cfg: { tools: { elevated: { allowFrom: { whatsapp: params.allowFrom } } } },
    agentId: "main",
    provider: "whatsapp",
    ctx: { ...sender, ...params.ctx },
  });

  expect(result).toEqual({
    enabled: true,
    allowed: params.allowed,
    failures: params.allowed
      ? []
      : [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
  });
}

it.each([
  { name: "authorizes when sender matches allowFrom", allowFrom: ["+15550001111"], allowed: true },
  {
    name: "does not authorize when only recipient matches allowFrom",
    allowFrom: ["+15559990000"],
    allowed: false,
  },
  {
    name: "does not authorize a group conversation id as a sender identity",
    allowFrom: ["120363411111111111@g.us", "from:120363411111111111@g.us"],
    allowed: false,
    ctx: {
      ChatType: "group",
      From: "120363411111111111@g.us",
      SenderId: "+15550002222",
      SenderE164: "+15550002222",
    },
  },
  {
    name: "keeps direct chat From fallback authorization",
    allowFrom: ["from:whatsapp:+15550001111"],
    allowed: true,
    ctx: {
      ChatType: "direct",
      From: "whatsapp:+15550001111",
      SenderId: undefined,
      SenderE164: undefined,
    },
  },
  {
    name: "does not authorize untyped mutable sender fields",
    allowFrom: ["owner-display-name"],
    allowed: false,
    ctx: {
      SenderName: "owner-display-name",
      SenderUsername: "owner-display-name",
      SenderTag: "owner-display-name",
    },
  },
  {
    name: "authorizes mutable sender fields only with explicit prefix",
    allowFrom: ["username:owner_username"],
    allowed: true,
    ctx: {
      SenderUsername: "owner_username",
    },
  },
])("$name", expectAllowFromDecision);
