import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  FIRECRAWL_CLI_AUTH_SOURCE,
  obtainFirecrawlApiKeyThroughBrowser,
} from "./firecrawl-browser-auth.js";

const openUrl = vi.hoisted(() => vi.fn(async () => true));
const isRemoteEnvironment = vi.hoisted(() => vi.fn(() => false));
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("./onboard-helpers.js", () => ({
  openUrl,
}));

vi.mock("./oauth-env.js", () => ({
  isRemoteEnvironment,
}));

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  openUrl.mockReset().mockResolvedValue(true);
  isRemoteEnvironment.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", mockFetch);
});

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("obtainFirecrawlApiKeyThroughBrowser", () => {
  it("opens cli-auth with source=openclaw and encoded code_challenge", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ apiKey: "fc-test", teamName: "T" }),
    });

    const stop = vi.fn();
    const prompter: Pick<WizardPrompter, "progress" | "note"> = {
      progress: vi.fn(() => ({ update: vi.fn(), stop })),
      note: vi.fn(async () => {}),
    };

    const result = await obtainFirecrawlApiKeyThroughBrowser({
      prompter: prompter as WizardPrompter,
      runtime: createRuntime(),
    });

    expect(result).toEqual({ apiKey: "fc-test", teamName: "T" });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^https://firecrawl\\.dev/cli-auth\\?code_challenge=[^&]+&source=${FIRECRAWL_CLI_AUTH_SOURCE}#session_id=[a-f0-9]{64}$`,
          "i",
        ),
      ),
    );
  });
});
