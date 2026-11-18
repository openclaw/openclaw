import { describe, expect, it } from "vitest";
import { normalizeCloudRepo } from "./cloud-worker-project-profiles.js";

describe("normalizeCloudRepo", () => {
  it.each([
    ["SSH origin", "git@github.com:Acme/App.git", "github.com/acme/app"],
    ["uppercase origin", "https://GITHUB.COM/ACME/APP", "github.com/acme/app"],
    ["missing owner and repo", "https://github.com", undefined],
    ["missing repo", "https://github.com/acme", undefined],
    [
      "ssh scheme origin with custom port",
      "ssh://git@github.com:2222/acme/app.git",
      "github.com/acme/app",
    ],
    [
      "https origin with userinfo",
      "https://user:token@github.com/acme/app.git",
      "github.com/acme/app",
    ],
    [
      "self-hosted nested path",
      "https://gitlab.example.com/group/sub/app.git",
      "gitlab.example.com/group/sub/app",
    ],
    ["path traversal", "https://github.com/acme/../app.git", undefined],
    ["unsupported scheme", "file:///tmp/repo.git", undefined],
    ["empty origin", "   ", undefined],
  ])("normalizes %s", (_label, originUrl, expected) => {
    expect(normalizeCloudRepo(originUrl)).toBe(expected);
  });
});
