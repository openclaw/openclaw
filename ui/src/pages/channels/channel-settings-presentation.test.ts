import { expect, it } from "vitest";
import { channelSettingsPath } from "./channel-settings-presentation.tsx";

it("encodes opaque account and path segments once under the selected channel", () => {
  expect(channelSettingsPath("nostr", "main/account", ["profile", "a?b#c"])).toBe(
    "/api/channels/nostr/main%2Faccount/profile/a%3Fb%23c",
  );
  expect(channelSettingsPath("nostr", "%2e%2e", ["%2e%2e"])).toBe(
    "/api/channels/nostr/%252e%252e/%252e%252e",
  );
});
it.each([".", "..", ""])(
  "rejects normalized traversal segment %j in accounts and paths",
  (segment) => {
    expect(() => channelSettingsPath("nostr", segment, ["profile"])).toThrow();
    expect(() => channelSettingsPath("nostr", "default", [segment])).toThrow();
  },
);
it("requires an operation path below the channel account", () => {
  expect(() => channelSettingsPath("nostr", "default", [])).toThrow();
});
