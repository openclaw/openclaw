import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runTelegramBotTokenRuntime, testing } from "./telegram-bot-token-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const leasedToken = "123456:leased-secret";
type Dependencies = NonNullable<Parameters<typeof runTelegramBotTokenRuntime>[2]>;

async function fixture() {
  const artifactBase = tempDirs.make("telegram-bot-token-");
  const release = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const instance = {
    cleanup: vi.fn(async () => undefined),
    startGateway: vi.fn(async () => undefined),
    logs: () =>
      `[qa-live] starting provider (@qa_test_bot) token=${leasedToken}\n` +
      "[telegram][diag] polling cycle started\n",
  };
  const createInstance = vi.fn<Dependencies["createInstance"]>(async () => instance);
  return {
    credential: { release, stop },
    instance,
    createInstance,
    run: (env: NodeJS.ProcessEnv = { OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: leasedToken }) =>
      runTelegramBotTokenRuntime(
        { artifactBase, repoRoot: process.cwd(), startupTimeoutMs: 100 },
        env,
        {
          createInstance,
          acquireCredential: async () => ({
            heartbeat: async () => undefined,
            heartbeatIntervalMs: 0,
            kind: "telegram",
            payload: { sutToken: leasedToken },
            release,
            source: "env",
          }),
          startCredentialHeartbeat: () => ({ stop, throwIfFailed: () => undefined }),
        },
      ),
    log: () => fs.readFile(path.join(artifactBase, "telegram-startup-getme-live.log"), "utf8"),
  };
}

describe("telegram bot token runtime evidence", () => {
  it("writes blocked evidence without a dedicated credential", async () => {
    const proof = await fixture();
    const evidence = await proof.run({
      OPENCLAW_QA_CREDENTIAL_SOURCE: "env",
      TELEGRAM_BOT_TOKEN: "generic-token",
    });

    expect(evidence.entries[0]?.result.status).toBe("blocked");
    const log = await proof.log();
    expect(log).toContain("blocked");
    expect(log).not.toContain("generic-token");
  });

  it("launches the real Gateway shape and redacts the leased token from evidence", async () => {
    const { run, log: readLog, instance, credential, createInstance } = await fixture();
    const evidence = await run();

    expect(evidence.entries[0]?.result.status).toBe("pass");
    expect(instance.startGateway).toHaveBeenCalledOnce();
    expect(instance.cleanup).toHaveBeenCalledOnce();
    expect(credential.stop).toHaveBeenCalledOnce();
    expect(credential.release).toHaveBeenCalledOnce();
    expect(createInstance.mock.calls[0]?.[0]).toMatchObject({
      config: {
        channels: {
          telegram: {
            defaultAccount: "qa-live",
            accounts: { "qa-live": { botToken: leasedToken } },
          },
        },
        plugins: {
          allow: ["telegram"],
          entries: { telegram: { enabled: true } },
        },
      },
      env: {
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
      },
    });
    const log = await readLog();
    expect(log).toContain("product startAccount resolved getMe bot identity before polling");
    expect(log).toContain("[REDAC");
    expect(log).not.toContain(leasedToken);
  });

  it("requires product startup to precede polling and bounds the wait", async () => {
    const { instance } = await fixture();
    instance.logs = () =>
      "[telegram][diag] polling cycle started\n[qa-live] starting provider (@qa_test_bot)\n";
    await expect(testing.waitForProductStartup(instance, 10)).rejects.toThrow(
      "product startup getMe timed out",
    );
  });

  it("redacts leased tokens from startup failure evidence", async () => {
    const { run, log, instance, credential } = await fixture();
    instance.logs = () => "";
    instance.startGateway.mockRejectedValue(
      new Error(`Telegram startup failed for https://api.telegram.org/bot${leasedToken}/getMe`),
    );
    const evidence = await run();
    expect(evidence.entries[0]?.result.status).toBe("fail");
    expect(JSON.stringify(evidence)).not.toContain(leasedToken);
    expect(await log()).not.toContain(leasedToken);
    expect(credential.release).toHaveBeenCalledOnce();
  });
});
