import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const CANCELLED = Symbol("clack:cancel");

const mocks = vi.hoisted(() => ({
  clackConfirm: vi.fn(),
  clackText: vi.fn(),
  clackSelect: vi.fn(),
  clackCancel: vi.fn(),
  upsertAuthProfile: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  cancel: (message: unknown) => mocks.clackCancel(message),
  confirm: (params: unknown) => mocks.clackConfirm(params),
  isCancel: (value: unknown) => value === CANCELLED,
  select: (params: unknown) => mocks.clackSelect(params),
  text: (params: unknown) => mocks.clackText(params),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  upsertAuthProfile: (params: unknown) => mocks.upsertAuthProfile(params),
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: (runtime: unknown) => mocks.logConfigUpdated(runtime),
}));

vi.mock("./shared.js", async (importActual) => {
  const actual = await importActual<typeof import("./shared.js")>();
  return {
    ...actual,
    updateConfig: (mutator: unknown) => mocks.updateConfig(mutator),
  };
});

const { modelsAuthPasteTokenCommand, modelsAuthSetupTokenCommand } = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("models auth cancel handling", () => {
  let restoreStdin: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateConfig.mockResolvedValue(undefined);

    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const previous = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });
    restoreStdin = () => {
      if (previous) {
        Object.defineProperty(stdin, "isTTY", previous);
      } else {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    };
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
  });

  it("does not persist a cancelled pasted token", async () => {
    const runtime = createRuntime();
    mocks.clackText.mockResolvedValueOnce(CANCELLED);

    await expect(
      modelsAuthPasteTokenCommand({ provider: "openai" }, runtime),
    ).resolves.toBeUndefined();

    expect(mocks.clackCancel).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("does not persist a cancelled setup token", async () => {
    const runtime = createRuntime();
    mocks.clackText.mockResolvedValueOnce(CANCELLED);

    await expect(
      modelsAuthSetupTokenCommand({ provider: "anthropic", yes: true }, runtime),
    ).resolves.toBeUndefined();

    expect(mocks.clackCancel).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
