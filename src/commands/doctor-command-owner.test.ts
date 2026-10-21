import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  formatCommandOwnerFromChannelSender,
  formatCommandOwnerHint,
  noteCommandOwnerHealth,
} from "./doctor-command-owner.js";

const note = vi.hoisted(() => vi.fn());
const owners = (...ownerAllowFrom: string[]) => ({ commands: { ownerAllowFrom } });

// mock-isolation: Capture command-owner diagnostics without writing to the operator's terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => note.mockClear());

it("formats pairing senders as channel-scoped command owners", () => {
  expect(
    ["123", "telegram:123"].map((id) =>
      formatCommandOwnerFromChannelSender({ channel: "telegram", id }),
    ),
  ).toEqual(["telegram:123", "telegram:123"]);
});

it("explains missing command owners in plain language", () => {
  const missing = [{}, owners(), owners("*"), owners("telegram:*")];
  missing.forEach(noteCommandOwnerHealth);
  expect(note.mock.calls).toEqual(
    missing.map(() => [
      [
        "No command owner is configured.",
        "A command owner is your trusted human operator account, allowed to update OpenClaw with /update, restart the Gateway, change configuration, and approve commands. Chat allowlists do not grant this authority.",
        "Run openclaw channels add and complete a channel's setup to choose your operator account, including servers and groups without DM pairing.",
        "CLI pairing approval records the first command owner. Control UI pairing approval has a separate owner checkbox.",
        "Fix: set commands.ownerAllowFrom to your channel user id, for example openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'",
        "Restart the gateway after changing this if it is already running.",
      ].join("\n"),
      "Command owner",
    ]),
  );
});

it.skipIf(process.platform === "win32")(
  "quotes a sender id without overriding the selected profile",
  () => {
    vi.stubEnv("OPENCLAW_PROFILE", "owner-proof");
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
  },
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
