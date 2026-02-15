import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "./prompts.js";

// Mock resolveOpenClawPackageName — default returns "openclaw" (upstream behaviour)
const mockResolvePackageName = vi.hoisted(() => vi.fn(async () => "openclaw"));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageName: mockResolvePackageName,
}));

function createMockPrompter(responses: {
  selectResponses?: unknown[];
  textResponses?: string[];
}): WizardPrompter {
  const selectResponses = [...(responses.selectResponses ?? [])];
  const textResponses = [...(responses.textResponses ?? [])];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => selectResponses.shift()),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => textResponses.shift() ?? ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("setupMemoryBackend", () => {
  it("returns config unchanged when builtin is selected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = { gateway: { mode: "local" } };
    const prompter = createMockPrompter({ selectResponses: ["builtin"] });

    const result = await setupMemoryBackend(config, prompter);

    expect(result).toBe(config);
  });

  it("prompts for URI and profile when mongodb is selected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(prompter.text).toHaveBeenCalledTimes(1);
    expect(result.memory?.backend).toBe("mongodb");
    expect(result.memory?.mongodb?.uri).toBe("mongodb+srv://user:pass@cluster.mongodb.net/");
    expect(result.memory?.mongodb?.deploymentProfile).toBe("atlas-default");
  });

  it("rejects empty URI via validation", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    let validateFn: ((value: string) => string | undefined) | undefined;
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    const origText = prompter.text;
    prompter.text = vi.fn(async (params) => {
      validateFn = params.validate;
      return origText(params);
    }) as WizardPrompter["text"];

    await setupMemoryBackend(config, prompter);

    expect(validateFn).toBeDefined();
    expect(validateFn!("")).toBe("URI is required for MongoDB backend");
    expect(validateFn!("   ")).toBe("URI is required for MongoDB backend");
  });

  it("rejects invalid URI scheme via validation", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    let validateFn: ((value: string) => string | undefined) | undefined;
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    const origText = prompter.text;
    prompter.text = vi.fn(async (params) => {
      validateFn = params.validate;
      return origText(params);
    }) as WizardPrompter["text"];

    await setupMemoryBackend(config, prompter);

    expect(validateFn).toBeDefined();
    expect(validateFn!("http://localhost")).toBe(
      "URI must start with mongodb:// or mongodb+srv://",
    );
    expect(validateFn!("postgres://localhost")).toBe(
      "URI must start with mongodb:// or mongodb+srv://",
    );
  });

  it("accepts valid URI schemes via validation", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};

    let validateFn: ((value: string) => string | undefined) | undefined;
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb://localhost:27017/"],
    });
    const origText = prompter.text;
    prompter.text = vi.fn(async (params) => {
      validateFn = params.validate;
      return origText(params);
    }) as WizardPrompter["text"];

    await setupMemoryBackend(config, prompter);

    expect(validateFn).toBeDefined();
    expect(validateFn!("mongodb://localhost:27017/")).toBeUndefined();
    expect(validateFn!("mongodb+srv://user:pass@cluster.mongodb.net/")).toBeUndefined();
  });

  it("auto-suggests atlas-default profile for Atlas URI", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });

    await setupMemoryBackend(config, prompter);

    // The second select call should have initialValue "atlas-default"
    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    expect(selectCalls.length).toBe(2);
    const profileSelectParams = selectCalls[1][0];
    expect(profileSelectParams.initialValue).toBe("atlas-default");
  });

  it("auto-suggests community-mongot profile for non-Atlas URI", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    await setupMemoryBackend(config, prompter);

    // The second select call should have initialValue "community-mongot"
    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    expect(selectCalls.length).toBe(2);
    const profileSelectParams = selectCalls[1][0];
    expect(profileSelectParams.initialValue).toBe("community-mongot");
  });

  it("sets backend to qmd when qmd is selected", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({ selectResponses: ["qmd"] });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.memory?.backend).toBe("qmd");
  });

  it("preserves existing config fields when selecting mongodb", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {
      gateway: { mode: "local" },
      memory: { citations: "on" },
    };
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    const result = await setupMemoryBackend(config, prompter);

    expect(result.gateway?.mode).toBe("local");
    expect(result.memory?.citations).toBe("on");
    expect(result.memory?.backend).toBe("mongodb");
  });

  it("defaults to mongodb when running as @romiluz/clawmongo", async () => {
    mockResolvePackageName.mockResolvedValueOnce("@romiluz/clawmongo");
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-bare"],
      textResponses: ["mongodb://localhost:27017/"],
    });

    await setupMemoryBackend(config, prompter);

    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    // First select is memory backend — initialValue should be "mongodb"
    expect(selectCalls[0][0].initialValue).toBe("mongodb");
    // MongoDB option should say "(Recommended)"
    const mongoOption = selectCalls[0][0].options.find(
      (o: { value: string }) => o.value === "mongodb",
    );
    expect(mongoOption.label).toContain("Recommended");
  });

  it("defaults to builtin when running as openclaw", async () => {
    mockResolvePackageName.mockResolvedValueOnce("openclaw");
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({ selectResponses: ["builtin"] });

    await setupMemoryBackend(config, prompter);

    const selectCalls = (prompter.select as ReturnType<typeof vi.fn>).mock.calls;
    expect(selectCalls[0][0].initialValue).toBe("builtin");
    const mongoOption = selectCalls[0][0].options.find(
      (o: { value: string }) => o.value === "mongodb",
    );
    expect(mongoOption.label).not.toContain("Recommended");
  });
});
