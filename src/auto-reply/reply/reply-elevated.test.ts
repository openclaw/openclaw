import { expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

const sender: MsgContext = {
  SenderId: "+15550001111",
  From: "whatsapp:+15550001111",
  SenderE164: "+15550001111",
  To: "+15559990000",
};

type PermissionCase = [string, string[], boolean, Partial<MsgContext>?];
it.each<PermissionCase>([
  ["authorizes the sender", ["+15550001111"], true],
  ["does not authorize the recipient", ["+15559990000"], false],
  [
    "does not authorize a group id as sender",
    ["120363411111111111@g.us", "from:120363411111111111@g.us"],
    false,
    {
      ChatType: "group",
      From: "120363411111111111@g.us",
      SenderId: "+15550002222",
      SenderE164: "+15550002222",
    },
  ],
  [
    "keeps direct chat From fallback",
    ["from:whatsapp:+15550001111"],
    true,
    {
      ChatType: "direct",
      SenderId: undefined,
      SenderE164: undefined,
    },
  ],
  [
    "does not authorize untyped mutable sender fields",
    ["owner-display-name"],
    false,
    {
      SenderName: "owner-display-name",
      SenderUsername: "owner-display-name",
      SenderTag: "owner-display-name",
    },
  ],
  [
    "authorizes explicitly prefixed mutable fields",
    ["username:owner_username"],
    true,
    { SenderUsername: "owner_username" },
  ],
])("%s", (_name, allowFrom, allowed, ctx = {}) => {
  expect(
    resolveElevatedPermissions({
      cfg: { tools: { elevated: { allowFrom: { whatsapp: allowFrom } } } },
      agentId: "main",
      provider: "whatsapp",
      ctx: { ...sender, ...ctx },
    }),
  ).toEqual({
    enabled: true,
    allowed,
    failures: allowed ? [] : [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
  });
});

// #51245: the live gate for a Telegram native slash command, with no channel
// plugin registered, must honor tools.elevated.allowFrom.telegram.
const telegramSlash: MsgContext = {
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
  CommandSource: "native",
  SessionKey: "telegram:slash:123456",
  SenderId: "123456",
  From: "telegram:123456",
};
it.each<[string, Array<string | number>, Partial<MsgContext>, boolean]>([
  ["authorizes a numeric sender id", ["123456"], {}, true],
  ["authorizes a number-typed sender id", [123456], {}, true],
  ["authorizes a telegram:-prefixed sender id", ["telegram:123456"], {}, true],
  ["denies a different sender", ["123456"], { SenderId: "999999", From: "telegram:999999" }, false],
])("telegram slash session %s", (_name, allowFrom, ctx, allowed) => {
  expect(
    resolveElevatedPermissions({
      cfg: { tools: { elevated: { enabled: true, allowFrom: { telegram: allowFrom } } } },
      agentId: "main",
      provider: "telegram",
      ctx: { ...telegramSlash, ...ctx },
    }),
  ).toEqual({
    enabled: true,
    allowed,
    failures: allowed ? [] : [{ gate: "allowFrom", key: "tools.elevated.allowFrom.telegram" }],
  });
});
