import { describe, expect, it } from "vitest";
import {
  isSafeScpRemoteHost,
  isSafeScpRemotePath,
  normalizeScpRemoteHost,
  normalizeScpRemotePath,
} from "./scp-host.js";

describe("scp remote host", () => {
  it("accepts host and user@host forms", () => {
    expect(normalizeScpRemoteHost("gateway-host")).toBe("gateway-host");
    expect(normalizeScpRemoteHost("bot@gateway-host")).toBe("bot@gateway-host");
    expect(normalizeScpRemoteHost("bot@192.168.64.3")).toBe("bot@192.168.64.3");
    expect(normalizeScpRemoteHost("bot@[fe80::1]")).toBe("bot@[fe80::1]");
  });

  it("rejects unsafe host tokens", () => {
    expect(isSafeScpRemoteHost("-oProxyCommand=whoami")).toBe(false);
    expect(isSafeScpRemoteHost("bot@gateway-host -oStrictHostKeyChecking=no")).toBe(false);
    expect(isSafeScpRemoteHost("bot@host:22")).toBe(false);
    expect(isSafeScpRemoteHost("bot@/tmp/host")).toBe(false);
    expect(isSafeScpRemoteHost("bot@@host")).toBe(false);
  });
});

describe("scp remote path", () => {
  it.each([
    {
      value: "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg",
      expected: "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg",
    },
    {
      value: " /Users/demo/Library/Messages/Attachments/ab/cd/IMG 1234 (1).jpg ",
      expected: "/Users/demo/Library/Messages/Attachments/ab/cd/IMG 1234 (1).jpg",
    },
  ])("normalizes safe paths for %j", ({ value, expected }) => {
    expect(normalizeScpRemotePath(value)).toBe(expected);
    expect(isSafeScpRemotePath(value)).toBe(true);
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "relative/path.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad$path.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad`path`.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad;path.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad|path.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad&path.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad<path.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad>path.jpg",
    '/Users/demo/Library/Messages/Attachments/ab/cd/bad"path.jpg',
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad'path.jpg",
    "/Users/demo/Library/Messages/Attachments/ab/cd/bad\\path.jpg",
  ])("rejects unsafe path tokens: %j", (value) => {
    expect(normalizeScpRemotePath(value)).toBeUndefined();
    expect(isSafeScpRemotePath(value)).toBe(false);
  });
});
