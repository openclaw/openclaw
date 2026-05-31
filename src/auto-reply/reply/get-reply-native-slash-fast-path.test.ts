import { describe, expect, it } from "vitest";
import { testing } from "./get-reply-native-slash-fast-path.js";

describe("native slash fast path", () => {
  it("keeps native slash commands on the fast path", () => {
    expect(
      testing.shouldRunNativeSlashCommandFastPath({
        Body: "/status",
        CommandBody: "/status",
        CommandSource: "native",
        CommandAuthorized: true,
      }),
    ).toBe(true);
  });

  it("runs text /approve on the fast path so approval commands do not queue behind approvals", () => {
    expect(
      testing.shouldRunNativeSlashCommandFastPath({
        Body: "/approve plugin:abc deny",
        CommandBody: "/approve plugin:abc deny",
        CommandSource: "text",
        CommandAuthorized: true,
      }),
    ).toBe(true);
  });

  it("runs authorized /approve on the fast path when channel command-source metadata is absent", () => {
    expect(
      testing.shouldRunNativeSlashCommandFastPath({
        Body: "/approve plugin:abc deny",
        CommandBody: "/approve plugin:abc deny",
        CommandAuthorized: true,
      }),
    ).toBe(true);
  });

  it("does not move other text slash commands onto the native fast path", () => {
    expect(
      testing.shouldRunNativeSlashCommandFastPath({
        Body: "/status",
        CommandBody: "/status",
        CommandSource: "text",
        CommandAuthorized: true,
      }),
    ).toBe(false);
  });
});
