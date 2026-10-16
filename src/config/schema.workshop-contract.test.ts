import { expect, it } from "vitest";
import { buildConfigSchemaCore } from "./schema.js";

it("C1: exposes Workshop settings labels, help, defaults and common settings tiers", () => {
  const { uiHints } = buildConfigSchemaCore();
  expect(uiHints["skills.workshop.autonomous.mode"]).toMatchObject({
    label: "Skill Workshop Autonomous Mode",
    help: 'Controls background learning: "auto" lets agents save and update Workshop skills after substantial work, and archives learned skills unused for 30 days. Every change is recorded and undoable. "off" disables background learning. Default: "auto".',
    advanced: false,
  });
  expect(uiHints["skills.workshop.autonomous.channelNotices"]).toMatchObject({
    label: "Skill Workshop Channel Notices",
    help: 'Post background review notices to channel conversations, except Slack, with an Undo button (default: false); the Control UI shows that message as plain text. When disabled, notices appear only as the Learned row in the Control UI chat. Saying "undo" works either way.',
    advanced: false,
  });
});
