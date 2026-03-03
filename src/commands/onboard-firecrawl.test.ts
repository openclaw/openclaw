import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { setupFirecrawl } from "./onboard-firecrawl.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const openUrl = vi.hoisted(() => vi.fn(async () => true));
const isRemoteEnvironment = vi.hoisted(() => vi.fn(() => false));

vi.mock("./onboard-helpers.js", () => ({
  openUrl,
}));

vi.mock("./oauth-env.js", () => ({
  isRemoteEnvironment,
}));

// Mock global fetch for polling tests.
const mockFetch = vi.hoisted(() => vi.fn());

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  openUrl.mockReset().mockResolvedValue(true);
  isRemoteEnvironment.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Re-stub fetch so module-level code doesn't break between tests.
  vi.stubGlobal("fetch", mockFetch);
  delete process.env.FIRECRAWL_API_KEY;
});

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

// Helper: set up fake timers that let polling resolve instantly.
function useFastTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupFirecrawl", () => {
  it("skips when API key already exists in config", async () => {
    const cfg = { tools: { web: { fetch: { firecrawl: { apiKey: "fc-existing" } } } } };
    const note = vi.fn(async () => {});
    const prompter = createWizardPrompter({ note });

    const result = await setupFirecrawl(cfg, createRuntime(), prompter);

    expect(result).toBe(cfg);
    expect(note).toHaveBeenCalledWith(
      "Firecrawl API key already configured.",
      "Firecrawl",
    );
  });

  it("skips when FIRECRAWL_API_KEY env var is set", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-from-env";
    const note = vi.fn(async () => {});
    const prompter = createWizardPrompter({ note });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result).toEqual({});
    expect(note).toHaveBeenCalledWith(
      "Firecrawl API key found in FIRECRAWL_API_KEY environment variable.",
      "Firecrawl",
    );
  });

  it("returns config unchanged when user declines", async () => {
    const confirm = vi.fn(async () => false);
    const prompter = createWizardPrompter({ confirm });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result).toEqual({});
  });

  it("stores key via manual entry with fc- prefix validation", async () => {
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "manual") as unknown as WizardPrompter["select"];
    const text = vi.fn(async () => "fc-test-key-123");
    const prompter = createWizardPrompter({ confirm, select, text });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result.tools?.web?.fetch?.firecrawl).toEqual({
      enabled: true,
      apiKey: "fc-test-key-123",
    });

    // Validate that the text prompt includes fc- validation.
    expect(text).toHaveBeenCalledTimes(1);
    const textArgs = (text.mock.calls as unknown as Array<Array<{ validate?: (v: string) => string | undefined }>>)[0]!;
    const validate = textArgs[0]!.validate!;
    expect(validate("")).toBe("API key is required");
    expect(validate("bad-key")).toBe('Firecrawl API keys start with "fc-"');
    expect(validate("fc-valid")).toBeUndefined();
  });

  it("handles browser auth flow success", async () => {
    useFastTimers();

    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "browser") as unknown as WizardPrompter["select"];
    const stopFn = vi.fn();
    const progress = vi.fn(() => ({ update: vi.fn(), stop: stopFn }));
    const prompter = createWizardPrompter({ confirm, select, progress });

    // First fetch call (poll) returns the API key.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apiKey: "fc-browser-key", teamName: "My Team" }),
    });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result.tools?.web?.fetch?.firecrawl).toEqual({
      enabled: true,
      apiKey: "fc-browser-key",
    });
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("firecrawl.dev/cli-auth"));
    expect(stopFn).toHaveBeenCalledWith(expect.stringContaining("Authenticated"));
  });

  it("handles browser auth timeout gracefully", async () => {
    useFastTimers();

    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "browser") as unknown as WizardPrompter["select"];
    const stopFn = vi.fn();
    const note = vi.fn(async () => {});
    const progress = vi.fn(() => ({ update: vi.fn(), stop: stopFn }));
    const prompter = createWizardPrompter({ confirm, select, progress, note });

    // Always return pending (no apiKey).
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    // Fast-forward Date.now() past the deadline after the first poll.
    const realDateNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      return realDateNow() + (callCount++ > 0 ? 10 * 60 * 1_000 : 0);
    });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result).toEqual({});
    expect(stopFn).toHaveBeenCalledWith("Timed out waiting for login.");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("timed out"),
      "Firecrawl",
    );
  });

  it("shows URL instead of opening browser in remote environment", async () => {
    useFastTimers();
    isRemoteEnvironment.mockReturnValue(true);

    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "browser") as unknown as WizardPrompter["select"];
    const note = vi.fn(async () => {});
    const stopFn = vi.fn();
    const progress = vi.fn(() => ({ update: vi.fn(), stop: stopFn }));
    const prompter = createWizardPrompter({ confirm, select, note, progress });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apiKey: "fc-remote-key" }),
    });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(openUrl).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Open this URL"),
      "Firecrawl",
    );
    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-remote-key");
  });

  it("catches errors during browser auth and returns config unchanged", async () => {
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "browser") as unknown as WizardPrompter["select"];
    const note = vi.fn(async () => {});
    const progress = vi.fn(() => {
      throw new Error("progress exploded");
    });
    const prompter = createWizardPrompter({ confirm, select, note, progress });
    const runtime = createRuntime();

    const result = await setupFirecrawl({}, runtime, prompter);

    expect(result).toEqual({});
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Something went wrong"),
      "Firecrawl",
    );
    expect(runtime.log).toHaveBeenCalled();
  });

  it("preserves existing config keys when storing firecrawl key", async () => {
    const existing = {
      tools: {
        web: {
          search: { enabled: true },
          fetch: {
            enabled: true,
            maxChars: 10_000,
          },
        },
      },
    };
    const confirm = vi.fn(async () => true);
    const select = vi.fn(async () => "manual") as unknown as WizardPrompter["select"];
    const text = vi.fn(async () => "fc-preserve-test");
    const prompter = createWizardPrompter({ confirm, select, text });

    const result = await setupFirecrawl(existing, createRuntime(), prompter);

    expect(result.tools?.web?.search).toEqual({ enabled: true });
    expect(result.tools?.web?.fetch?.enabled).toBe(true);
    expect(result.tools?.web?.fetch?.maxChars).toBe(10_000);
    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-preserve-test");
  });
});
