import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mockRunCapability = vi.hoisted(() => vi.fn());

vi.mock("../media-understanding/runner.js", () => ({
  runCapability: mockRunCapability,
}));

import { maybeHandleFoodImageCapture } from "./food-capture.js";

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "liev", default: true }],
    },
  } as unknown as OpenClawConfig;
}

describe("food-capture", () => {
  const envSnapshot = {
    url: process.env.LIONROOT_FOOD_CAPTURE_URL,
    token: process.env.LIONROOT_FOOD_CAPTURE_TOKEN,
    account: process.env.LIONROOT_FOOD_CAPTURE_IMESSAGE_ACCOUNT_ID,
  };

  beforeEach(() => {
    process.env.LIONROOT_FOOD_CAPTURE_URL = "https://command-post.test/api/inbox/intake/food-image";
    process.env.LIONROOT_FOOD_CAPTURE_TOKEN = "food-token";
    process.env.LIONROOT_FOOD_CAPTURE_IMESSAGE_ACCOUNT_ID = "lionheart";
    mockRunCapability.mockReset();
  });

  afterEach(() => {
    process.env.LIONROOT_FOOD_CAPTURE_URL = envSnapshot.url;
    process.env.LIONROOT_FOOD_CAPTURE_TOKEN = envSnapshot.token;
    process.env.LIONROOT_FOOD_CAPTURE_IMESSAGE_ACCOUNT_ID = envSnapshot.account;
    vi.unstubAllGlobals();
  });

  it("ignores non-food image descriptions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "food-capture-"));
    const mediaPath = path.join(tempDir, "image.jpg");
    await fs.writeFile(mediaPath, Buffer.from([1, 2, 3]));
    mockRunCapability.mockResolvedValue({
      outputs: [{ kind: "image.description", text: "a screenshot of a text conversation" }],
      decision: { capability: "image", outcome: "success", attachments: [] },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const handled = await maybeHandleFoodImageCapture({
      cfg: createConfig(),
      bodyText: "<media:image>",
      mediaPath,
      mediaType: "image/jpeg",
      sender: "+15551234567",
      accountId: "lionheart",
      isGroup: false,
      sendMessage: vi.fn(),
    });

    expect(handled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads likely food images to the openclaw intake endpoint and acknowledges the sender", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "food-capture-"));
    const mediaPath = path.join(tempDir, "meal.jpg");
    await fs.writeFile(mediaPath, Buffer.from([1, 2, 3]));
    mockRunCapability.mockResolvedValue({
      outputs: [{ kind: "image.description", text: "a bowl of chicken and rice" }],
      decision: { capability: "image", outcome: "success", attachments: [] },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const handled = await maybeHandleFoodImageCapture({
      cfg: createConfig(),
      bodyText: "<media:image>",
      mediaPath,
      mediaType: "image/jpeg",
      sender: "+15551234567",
      accountId: "lionheart",
      isGroup: false,
      sendMessage,
      sendOptions: { accountId: "lionheart" },
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(process.env.LIONROOT_FOOD_CAPTURE_URL);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer food-token",
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "+15551234567",
      "✓ Added to today's food log in Command Post.",
      { accountId: "lionheart" },
    );
  });

  it("acknowledges and short-circuits when the upload fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "food-capture-"));
    const mediaPath = path.join(tempDir, "meal.jpg");
    await fs.writeFile(mediaPath, Buffer.from([1, 2, 3]));
    mockRunCapability.mockResolvedValue({
      outputs: [{ kind: "image.description", text: "a bowl of chicken and rice" }],
      decision: { capability: "image", outcome: "success", attachments: [] },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const handled = await maybeHandleFoodImageCapture({
      cfg: createConfig(),
      bodyText: "<media:image>",
      mediaPath,
      mediaType: "image/jpeg",
      sender: "+15551234567",
      accountId: "lionheart",
      isGroup: false,
      sendMessage,
      sendOptions: { accountId: "lionheart" },
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "+15551234567",
      "⚠️ Could not add that to today's food log. Try again in a bit.",
      { accountId: "lionheart" },
    );
  });
});
