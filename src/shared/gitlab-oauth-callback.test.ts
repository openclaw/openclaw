import { expect, it } from "vitest";
import {
  managedGitLabCallbackRequestId,
  parseGitLabOAuthCallback,
} from "./gitlab-oauth-callback.js";

const redirect = "https://gateway.example.test/control/oauth/gitlab/callback";
it("requires one code and state at the exact configured redirect", () => {
  expect(parseGitLabOAuthCallback(redirect, `${redirect}?code=synthetic&state=synthetic`)).toEqual({
    code: "synthetic",
    state: "synthetic",
  });
  for (const callback of [
    `${redirect}?code=one&code=two&state=synthetic`,
    `${redirect}?code=one&state=one&state=two`,
    `${redirect}?code=one&state=synthetic&extra=value`,
    `${redirect}?code=one&state=synthetic#fragment`,
    `${redirect}?error=denied&state=synthetic`,
    `${redirect}/other?code=one&state=synthetic`,
    `https://other.example.test/control/oauth/gitlab/callback?code=one&state=synthetic`,
  ]) {
    expect(() => parseGitLabOAuthCallback(redirect, callback)).toThrow("callback is invalid");
  }
});
it("extracts only a well-formed managed routing hint without authorizing it", () => {
  const requestId = `gitlab-setup-${"a".repeat(32)}`;
  const state = `gitlab-managed.${requestId}.${"b".repeat(43)}`;
  expect(managedGitLabCallbackRequestId(`${redirect}?code=synthetic&state=${state}`)).toBe(
    requestId,
  );
  expect(managedGitLabCallbackRequestId(`${redirect}?state=${state}&state=${state}`)).toBeNull();
  expect(managedGitLabCallbackRequestId(`${redirect}?state=synthetic`)).toBeNull();
  expect(managedGitLabCallbackRequestId("invalid")).toBeNull();
});
