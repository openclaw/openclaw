import { execFileSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  formatCommandOwnerFromChannelSender,
  formatCommandOwnerHint,
  noteCommandOwnerHealth,
} from "./doctor-command-owner.js";

const note = vi.hoisted(() => vi.fn());
const owners = (...ownerAllowFrom: string[]) => ({ commands: { ownerAllowFrom } });

// mock-isolation: Capture command-owner diagnostics without writing to the operator's terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

beforeEach(() => note.mockClear());

it("formats pairing senders as channel-scoped command owners", () => {
  expect(
    ["123", "telegram:123"].map((id) =>
      formatCommandOwnerFromChannelSender({ channel: "telegram", id }),
    ),
  ).toEqual(["telegram:123", "telegram:123"]);
});

it.each([{}, { channels: {} }, owners(), owners("*"), owners("telegram:*")])(
  "explains local administrator recovery without requiring a channel: %j",
  (cfg) => {
    noteCommandOwnerHealth(cfg);

    const message = note.mock.calls[0]?.[0];
    expect(message).toContain("No channel command owner is configured.");
    expect(message).toContain("operator.admin");
    expect(message).toContain("no channel is required");
    expect(message).toContain("openclaw dashboard");
    expect(message).toContain("Inbox > System > Limited access > Request admin");
    expect(message).toContain("openclaw devices approve <requestId>");
    expect(message).toContain("For external channels");
    expect(message).toContain("commands.ownerAllowFrom");
  },
);

it.skipIf(process.platform === "win32")(
  "quotes a sender id without overriding the selected profile",
  () =>
    withEnv({ OPENCLAW_PROFILE: "owner-proof" }, () => {
      const id = "@o'brien$(printf injected) --profile decoy:example.org";
      const hint = formatCommandOwnerHint({ cfg: {}, channel: "matrix", id });
      const command = hint.slice(hint.indexOf("`") + 1, hint.lastIndexOf("`"));
      const shellCommand = command.replace(/^openclaw /, "printf '%s\\n' ");
      const args = execFileSync("/bin/sh", ["-c", shellCommand], { encoding: "utf8" })
        .trim()
        .split("\n");
      expect(args).toEqual(
        "--profile owner-proof config set commands.ownerAllowFrom"
          .split(" ")
          .concat(JSON.stringify([`matrix:${id}`])),
      );
    }),
);

it.each<[Parameters<typeof formatCommandOwnerHint>[0], string]>([
  [
    {
      cfg: owners("slack:owner", "telegram:123", "slack:owner", "*", "telegram:*"),
      channel: "telegram",
      id: "123",
    },
    `Ask the operator to run \`openclaw config set commands.ownerAllowFrom '["slack:owner","telegram:123"]'\` in a terminal to make this sender a command owner.`,
  ],
  [
    { channel: "telegram", id: "123" },
    "Ask the operator to add `telegram:123` to `commands.ownerAllowFrom`.",
  ],
  [
    { cfg: {}, channel: "webchat", id: "123" },
    "Ask the operator to grant this Gateway client operator.admin access.",
  ],
])("formats owner guidance: %j", (params, expected) =>
  expect(formatCommandOwnerHint(params)).toBe(expected),
);

it("does not warn when command owners are configured", () => {
  noteCommandOwnerHealth(owners("telegram:123"));

  expect(note).not.toHaveBeenCalled();
});
