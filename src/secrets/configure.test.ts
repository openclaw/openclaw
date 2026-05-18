import { beforeEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.hoisted(() => vi.fn());
const createSecretsConfigIOMock = vi.hoisted(() => vi.fn());
const loadPersistedAuthProfileStoreMock = vi.hoisted(() => vi.fn());

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: (...args: unknown[]) => selectMock(...args),
  text: vi.fn(),
}));

vi.mock("./config-io.js", () => ({
  createSecretsConfigIO: (...args: unknown[]) => createSecretsConfigIOMock(...args),
}));

vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: (...args: unknown[]) => loadPersistedAuthProfileStoreMock(...args),
}));

const { runSecretsConfigureInteractive } = await import("./configure.js");

describe("runSecretsConfigureInteractive", () => {
  beforeEach(() => {
    selectMock.mockReset();
    createSecretsConfigIOMock.mockReset();
    loadPersistedAuthProfileStoreMock.mockReset();
  });

  it("does not load auth-profiles when running providers-only", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    selectMock.mockResolvedValue("continue");
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });
    await expect(runSecretsConfigureInteractive({ providersOnly: true })).rejects.toThrow(
      "No secrets changes were selected.",
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });
});
