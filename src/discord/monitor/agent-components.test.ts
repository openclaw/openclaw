import type { ButtonInteraction, ComponentData, StringSelectMenuInteraction } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createAgentComponentButton, createAgentSelectMenu } from "./agent-components.js";

const readAllowFromStoreMock = vi.hoisted(() => vi.fn());
const upsertPairingRequestMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../../infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/system-events.js")>();
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
  };
});

const createCfg = (): OpenClawConfig => ({}) as OpenClawConfig;

const createDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const defer = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    rawData: { channel_id: "dm-channel" },
    user: { id: "123456789", username: "Alice", discriminator: "1234" },
    defer,
    reply,
    ...overrides,
  } as unknown as ButtonInteraction;
  return { interaction, defer, reply };
};

const createDmSelectInteraction = (overrides: Partial<StringSelectMenuInteraction> = {}) => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const defer = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    rawData: { channel_id: "dm-channel" },
    user: { id: "123456789", username: "Alice", discriminator: "1234" },
    values: ["alpha"],
    defer,
    reply,
    ...overrides,
  } as unknown as StringSelectMenuInteraction;
  return { interaction, defer, reply };
};

beforeEach(() => {
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  enqueueSystemEventMock.mockReset();
});

describe("agent components", () => {
  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]?.content).toContain("Pairing code: PAIRCODE");
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("allows DM interactions when pairing store allowlist matches", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "✓" });
    expect(enqueueSystemEventMock).toHaveBeenCalled();
  });

  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["Alice#1234"],
    });
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "✓" });
    expect(enqueueSystemEventMock).toHaveBeenCalled();
  });
});
