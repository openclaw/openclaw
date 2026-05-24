import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  COPILOT_SDK_FALLBACK_DIR,
  COPILOT_SDK_SPEC,
  ensureCopilotSdkForModelSelection,
  installCopilotSdk,
  isCopilotSdkInstalled,
  selectedModelShouldEnsureCopilotSdk,
} from "./copilot-sdk-install.js";

function fakeRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: () => undefined,
  };
}

function fakePrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  const noop = async () => undefined as never;
  return {
    intro: async () => undefined,
    outro: async () => undefined,
    note: async () => undefined,
    plain: async () => undefined,
    select: noop,
    multiselect: noop,
    text: async () => "",
    confirm: async () => true,
    progress: () => ({ update: () => undefined, stop: () => undefined }),
    ...overrides,
  } as WizardPrompter;
}

const emptyCfg = {} as OpenClawConfig;

describe("selectedModelShouldEnsureCopilotSdk", () => {
  it("returns true for github-copilot/* model refs", () => {
    expect(
      selectedModelShouldEnsureCopilotSdk({
        cfg: emptyCfg,
        model: "github-copilot/gpt-4o",
      }),
    ).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(
      selectedModelShouldEnsureCopilotSdk({ cfg: emptyCfg, model: "anthropic/claude-3" }),
    ).toBe(false);
    expect(selectedModelShouldEnsureCopilotSdk({ cfg: emptyCfg, model: "openai/gpt-4o" })).toBe(
      false,
    );
  });

  it("returns false when model is undefined", () => {
    expect(selectedModelShouldEnsureCopilotSdk({ cfg: emptyCfg })).toBe(false);
  });
});

describe("ensureCopilotSdkForModelSelection", () => {
  it("returns required=false and no-ops when model is not github-copilot", async () => {
    const confirm = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: emptyCfg,
      model: "anthropic/claude-3",
      prompter: fakePrompter({ confirm }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
    });
    expect(result.required).toBe(false);
    expect(result.installed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns already-installed without prompting when SDK is present", async () => {
    const confirm = vi.fn();
    const install = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: emptyCfg,
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm }),
      runtime: fakeRuntime(),
      isInstalled: () => true,
      install,
    });
    expect(result.required).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.status).toBe("already-installed");
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("prompts and installs when SDK is missing and user confirms", async () => {
    const confirm = vi.fn(async () => true);
    const install = vi.fn(async () => ({
      installed: true,
      fallbackDir: COPILOT_SDK_FALLBACK_DIR,
      spec: COPILOT_SDK_SPEC,
    }));
    const result = await ensureCopilotSdkForModelSelection({
      cfg: emptyCfg,
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
      install,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(result.required).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
  });

  it("respects user decline and reports status=declined", async () => {
    const confirm = vi.fn(async () => false);
    const install = vi.fn();
    const note = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: emptyCfg,
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm, note }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
      install,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledOnce();
    expect(result.required).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.status).toBe("declined");
  });

  it("reports status=failed and surfaces error via note when install throws", async () => {
    const confirm = vi.fn(async () => true);
    const install = vi.fn(async () => {
      throw new Error("network down");
    });
    const note = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: emptyCfg,
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm, note }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
      install,
    });
    expect(result.required).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.status).toBe("failed");
    expect(note).toHaveBeenCalledOnce();
    const noteMessage = (note as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!;
    expect(noteMessage).toContain("network down");
    expect(noteMessage).toContain("npm install @github/copilot-sdk");
  });
});

describe("installCopilotSdk", () => {
  it("runs the install command and bootstraps package.json when SDK missing", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    try {
      const runInstall = vi.fn(async ({ dir }: { dir: string; spec: string }) => {
        fs.mkdirSync(path.join(dir, "node_modules", "@github", "copilot-sdk"), {
          recursive: true,
        });
      });
      const result = await installCopilotSdk({
        fallbackDir: tmp,
        runInstall,
      });
      expect(runInstall).toHaveBeenCalledOnce();
      expect(result.installed).toBe(true);
      expect(fs.existsSync(path.join(tmp, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, "node_modules", "@github", "copilot-sdk"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns installed=false when SDK already present (skip install)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    try {
      fs.mkdirSync(path.join(tmp, "node_modules", "@github", "copilot-sdk"), {
        recursive: true,
      });
      const runInstall = vi.fn();
      const result = await installCopilotSdk({ fallbackDir: tmp, runInstall });
      expect(runInstall).not.toHaveBeenCalled();
      expect(result.installed).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws when runInstall succeeds but SDK still missing", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    try {
      const runInstall = vi.fn(async () => undefined);
      await expect(installCopilotSdk({ fallbackDir: tmp, runInstall })).rejects.toThrow(/missing/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("constants", () => {
  it("exports fallback dir under ~/.openclaw/npm-runtime/copilot", () => {
    expect(COPILOT_SDK_FALLBACK_DIR).toMatch(/\.openclaw[\\/]+npm-runtime[\\/]+copilot$/);
  });

  it("pins SDK spec to @github/copilot-sdk@1.0.0-beta.4", () => {
    expect(COPILOT_SDK_SPEC).toBe("@github/copilot-sdk@1.0.0-beta.4");
  });

  it("isCopilotSdkInstalled returns false for nonexistent dirs", () => {
    expect(isCopilotSdkInstalled("/tmp/definitely-does-not-exist-openclaw")).toBe(false);
  });
});
