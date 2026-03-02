import { describe, expect, it } from "vitest";
import { resolveProxyAuthChallengeResponse } from "./chrome.js";

describe("browser chrome proxy auth challenge handling", () => {
  const proxyCredentials = {
    username: "proxy-user",
    password: "proxy-pass",
  };

  it("provides credentials for proxy challenges", () => {
    expect(resolveProxyAuthChallengeResponse("Proxy", proxyCredentials)).toEqual({
      response: "ProvideCredentials",
      username: "proxy-user",
      password: "proxy-pass",
    });
  });

  it("treats proxy source case-insensitively", () => {
    expect(resolveProxyAuthChallengeResponse("pRoXy", proxyCredentials)).toEqual({
      response: "ProvideCredentials",
      username: "proxy-user",
      password: "proxy-pass",
    });
  });

  it("does not send proxy credentials for origin server auth challenges", () => {
    expect(resolveProxyAuthChallengeResponse("Server", proxyCredentials)).toEqual({
      response: "Default",
    });
  });

  it("defaults safely when auth challenge source is missing", () => {
    expect(resolveProxyAuthChallengeResponse(undefined, proxyCredentials)).toEqual({
      response: "Default",
    });
  });
});
