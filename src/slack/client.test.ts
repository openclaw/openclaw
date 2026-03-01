import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@slack/web-api", () => {
  const WebClient = vi.fn(function WebClientMock(
    this: Record<string, unknown>,
    token: string,
    options?: Record<string, unknown>,
  ) {
    this.token = token;
    this.options = options;
  });
  return { WebClient };
});

const slackWebApi = await import("@slack/web-api");
const { createSlackWebClient, resolveSlackWebClientOptions, SLACK_DEFAULT_RETRY_OPTIONS } =
  await import("./client.js");

const WebClient = slackWebApi.WebClient as unknown as ReturnType<typeof vi.fn>;

describe("slack web client config", () => {
  it("applies the default retry config when none is provided", () => {
    const options = resolveSlackWebClientOptions();

    expect(options.retryConfig).toEqual(SLACK_DEFAULT_RETRY_OPTIONS);
  });

  it("respects explicit retry config overrides", () => {
    const customRetry = { retries: 0 };
    const options = resolveSlackWebClientOptions({ retryConfig: customRetry });

    expect(options.retryConfig).toBe(customRetry);
  });

  it("passes merged options into WebClient", () => {
    createSlackWebClient("xoxb-test", { timeout: 1234 });

    expect(WebClient).toHaveBeenCalledWith(
      "xoxb-test",
      expect.objectContaining({
        timeout: 1234,
        retryConfig: SLACK_DEFAULT_RETRY_OPTIONS,
      }),
    );
  });
});

describe("slack api url override", () => {
  const originalEnv = process.env.SLACK_API_URL;

  beforeEach(() => {
    delete process.env.SLACK_API_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SLACK_API_URL = originalEnv;
    } else {
      delete process.env.SLACK_API_URL;
    }
  });

  it("does not include slackApiUrl when not set", () => {
    const options = resolveSlackWebClientOptions();

    expect(options.slackApiUrl).toBeUndefined();
  });

  it("reads slackApiUrl from SLACK_API_URL env var", () => {
    process.env.SLACK_API_URL = "https://proxy.example.com/slack/";
    const options = resolveSlackWebClientOptions();

    expect(options.slackApiUrl).toBe("https://proxy.example.com/slack/");
  });

  it("prefers explicit slackApiUrl option over env var", () => {
    process.env.SLACK_API_URL = "https://env.example.com/";
    const options = resolveSlackWebClientOptions({
      slackApiUrl: "https://explicit.example.com/",
    });

    expect(options.slackApiUrl).toBe("https://explicit.example.com/");
  });

  it("passes slackApiUrl to WebClient", () => {
    process.env.SLACK_API_URL = "https://proxy.example.com/api/";
    createSlackWebClient("xoxb-test");

    expect(WebClient).toHaveBeenCalledWith(
      "xoxb-test",
      expect.objectContaining({
        slackApiUrl: "https://proxy.example.com/api/",
      }),
    );
  });
});
