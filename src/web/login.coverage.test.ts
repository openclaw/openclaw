import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginWeb } from "./login.js";
import { createWaSocket, formatError, waitForWaConnection } from "./session.js";

const rmMock = vi.spyOn(fs, "rm");

function resolveTestAuthDir() {
  return path.join(os.tmpdir(), "wa-creds");
}

const authDir = resolveTestAuthDir();

vi.mock("../config/config.js", () => ({
  loadConfig: () =>
    ({
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: true, authDir: resolveTestAuthDir() },
          },
        },
      },
    }) as never,
}));

vi.mock("./session.js", () => {
  const authDir = resolveTestAuthDir();
  const sockA = { ws: { close: vi.fn() } };
  const sockB = { ws: { close: vi.fn() } };
  let call = 0;
  const createWaSocket = vi.fn(async () => (call++ === 0 ? sockA : sockB));
  const waitForWaConnection = vi.fn();
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  return {
    createWaSocket,
    waitForWaConnection,
    formatError,
    WA_WEB_AUTH_DIR: authDir,
    logoutWeb: vi.fn(async (params: { authDir?: string }) => {
      await fs.rm(params.authDir ?? authDir, {
        recursive: true,
        force: true,
      });
      return true;
    }),
  };
});

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const formatErrorMock = vi.mocked(formatError);

describe("loginWeb coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    rmMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts once when WhatsApp requests code 515", async () => {
    waitForWaConnectionMock
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);

    const runtime = { log: vi.fn(), error: vi.fn() } as never;
    await loginWeb(false, waitForWaConnectionMock as never, runtime);

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    const firstSock = await createWaSocketMock.mock.results[0]?.value;
    expect(firstSock.ws.close).toHaveBeenCalled();
    vi.runAllTimers();
    const secondSock = await createWaSocketMock.mock.results[1]?.value;
    expect(secondSock.ws.close).toHaveBeenCalled();
  });

  it("clears creds and throws when logged out", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: DisconnectReason.loggedOut },
    });

    await expect(loginWeb(false, waitForWaConnectionMock as never)).rejects.toThrow(
      /cache cleared/i,
    );
    expect(rmMock).toHaveBeenCalledWith(authDir, {
      recursive: true,
      force: true,
    });
  });

  it("formats and rethrows generic errors", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce(new Error("boom"));
    await expect(loginWeb(false, waitForWaConnectionMock as never)).rejects.toThrow(
      "formatted:Error: boom",
    );
    expect(formatErrorMock).toHaveBeenCalled();
  });
});
