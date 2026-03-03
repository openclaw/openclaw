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

vi.mock("./onboard-helpers.js", () => ({ openUrl }));
vi.mock("./oauth-env.js", () => ({ isRemoteEnvironment }));

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
  vi.stubGlobal("fetch", mockFetch);
  delete process.env.FIRECRAWL_API_KEY;
});

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function useFastTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupFirecrawl", () => {
  it("skips when API key already exists in config", async () => {
    const cfg = { tools: { web: { fetch: { firecrawl: { apiKey: "fc-existing" } } } } };
    const prompter = createWizardPrompter();

    const result = await setupFirecrawl(cfg, createRuntime(), prompter);

    expect(result).toBe(cfg);
  });

  it("skips when FIRECRAWL_API_KEY env var is set", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-from-env";
    const prompter = createWizardPrompter();

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result).toEqual({});
  });

  it("returns config unchanged when user declines", async () => {
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result).toEqual({});
  });

  it("stores key and enables tools via manual entry", async () => {
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "manual") as unknown as WizardPrompter["select"],
      text: vi.fn(async () => "fc-test-key-123"),
    });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result.tools?.web?.fetch?.firecrawl).toEqual({
      enabled: true,
      apiKey: "fc-test-key-123",
    });
    expect(result.tools?.alsoAllow).toEqual(
      expect.arrayContaining(["firecrawl_search", "firecrawl_scrape", "browser"]),
    );
  });

  it("deduplicates alsoAllow when tools already exist", async () => {
    const existing = {
      tools: { alsoAllow: ["firecrawl_search", "some_other_tool"] },
    };
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "manual") as unknown as WizardPrompter["select"],
      text: vi.fn(async () => "fc-dedup-key"),
    });

    const result = await setupFirecrawl(existing, createRuntime(), prompter);

    const counts = result.tools!.alsoAllow!.filter((t: string) => t === "firecrawl_search");
    expect(counts).toHaveLength(1);
    expect(result.tools?.alsoAllow).toContain("some_other_tool");
  });

  it("handles browser auth flow success", async () => {
    useFastTimers();

    const stopFn = vi.fn();
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "browser") as unknown as WizardPrompter["select"],
      progress: vi.fn(() => ({ update: vi.fn(), stop: stopFn })),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apiKey: "fc-browser-key", teamName: "My Team" }),
    });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-browser-key");
    expect(result.tools?.alsoAllow).toEqual(
      expect.arrayContaining(["firecrawl_search", "firecrawl_scrape", "browser"]),
    );
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("source=openclaw"));
    expect(stopFn).toHaveBeenCalledWith(expect.stringContaining("Authenticated"));
  });

  it("includes source=openclaw in auth URL", async () => {
    useFastTimers();

    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "browser") as unknown as WizardPrompter["select"],
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apiKey: "fc-source-key" }),
    });

    await setupFirecrawl({}, createRuntime(), prompter);

    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("&source=openclaw#session_id="));
  });

  it("handles browser auth timeout gracefully", async () => {
    useFastTimers();

    const stopFn = vi.fn();
    const note = vi.fn(async () => {});
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "browser") as unknown as WizardPrompter["select"],
      progress: vi.fn(() => ({ update: vi.fn(), stop: stopFn })),
      note,
    });

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const realDateNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      return realDateNow() + (callCount++ > 0 ? 10 * 60 * 1_000 : 0);
    });

    const result = await setupFirecrawl({}, createRuntime(), prompter);

    expect(result).toEqual({});
    expect(stopFn).toHaveBeenCalledWith("Timed out waiting for login.");
  });

  it("preserves existing config keys when storing firecrawl key", async () => {
    const existing = {
      tools: {
        web: {
          search: { enabled: true },
          fetch: { enabled: true, maxChars: 10_000 },
        },
      },
    };
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "manual") as unknown as WizardPrompter["select"],
      text: vi.fn(async () => "fc-preserve-test"),
    });

    const result = await setupFirecrawl(existing, createRuntime(), prompter);

    expect(result.tools?.web?.search).toEqual({ enabled: true });
    expect(result.tools?.web?.fetch?.maxChars).toBe(10_000);
    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-preserve-test");
  });
});
