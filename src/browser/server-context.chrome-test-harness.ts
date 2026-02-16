import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";

const chromeUserDataDir = { dir: "/tmp/smart-agent-neo" };

beforeAll(async () => {
  chromeUserDataDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), "smart-agent-neo-chrome-user-data-"));
});

afterAll(async () => {
  await fs.rm(chromeUserDataDir.dir, { recursive: true, force: true });
});

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchSmartAgentNeoChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveSmartAgentNeoUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopSmartAgentNeoChrome: vi.fn(async () => {}),
}));
