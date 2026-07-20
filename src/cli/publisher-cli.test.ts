import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPublisherCli } from "./publisher-cli.js";

describe("publisher CLI", () => {
  it("registers the follow lifecycle as one top-level command group", () => {
    const program = new Command().name("openclaw");
    registerPublisherCli(program);

    const publisher = program.commands.find((command) => command.name() === "publisher");
    expect(publisher?.commands.map((command) => command.name())).toEqual([
      "search",
      "list",
      "follow",
      "unfollow",
      "refresh",
    ]);
    expect(publisher?.commands.find((command) => command.name() === "follow")?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ long: "--feed-profile" }),
        expect.objectContaining({ long: "--json" }),
      ]),
    );
    expect(
      publisher?.commands
        .find((command) => command.name() === "follow")
        ?.options.find((option) => option.long === "--feed-profile")?.mandatory,
    ).toBe(true);
  });

  it("rejects searches without text or a kind before creating dependencies", async () => {
    const program = new Command().name("openclaw");
    registerPublisherCli(program);

    await expect(
      program.parseAsync(
        ["publisher", "search", "publishers:alice", "--feed-profile", "clawhub-public"],
        { from: "user" },
      ),
    ).rejects.toThrow("publisher search requires query text or --kind");
  });
});
