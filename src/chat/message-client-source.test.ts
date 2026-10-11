import { describe, expect, it } from "vitest";
import {
  normalizeMessageClientSources,
  readMessageClientSources,
} from "./message-client-source.js";

describe("message client sources", () => {
  it("retains distinct reported apps without treating extra client fields as attribution", () => {
    const client = {
      id: "cli",
      mode: "cli",
      displayName: " Release helper ",
      platform: "linux",
      instanceId: "private-instance",
    };
    const sources = normalizeMessageClientSources([
      client,
      client,
      { id: "cli", mode: "cli", displayName: "Another helper" },
      { id: "not-a-client", mode: "cli", displayName: "Forged sender" },
      { id: "cli", mode: "not-a-mode" },
    ]);
    client.displayName = "Changed after admission";
    expect(sources).toEqual([
      { id: "cli", mode: "cli", displayName: "Release helper" },
      { id: "cli", mode: "cli", displayName: "Another helper" },
    ]);
  });

  it("bounds source labels without splitting a Unicode character", () => {
    expect(
      normalizeMessageClientSources([
        { id: "cli", mode: "cli", displayName: `${"a".repeat(199)}🦞` },
      ]),
    ).toEqual([{ id: "cli", mode: "cli", displayName: "a".repeat(199) }]);
  });

  it("uses only recorded transport sources and leaves older messages unlabeled", () => {
    expect(
      readMessageClientSources({ role: "user", senderLabel: "CLI", content: "From CLI" }),
    ).toEqual([]);
    expect(
      readMessageClientSources({
        __openclaw: { transport: { clients: [{ id: "cli", mode: "cli" }] } },
      }),
    ).toEqual([{ id: "cli", mode: "cli" }]);
  });
});
