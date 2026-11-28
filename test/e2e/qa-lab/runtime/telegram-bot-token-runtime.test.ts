import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runTelegramBotTokenRuntime, testing } from "./telegram-bot-token-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const leasedToken = "123456:leased-secret";
type Dependencies = NonNullable<Parameters<typeof runTelegramBotTokenRuntime>[2]>;

function fixture() {
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

it.each(["blocked", "pass", "fail"] as const)(
  "writes %s evidence without leaking credentials",
  async (status) => {
    const { run, log, instance, credential, createInstance } = fixture();
    if (status === "fail") {
      instance.logs = () => "";
      instance.startGateway.mockRejectedValue(
        new Error(`Telegram startup failed for https://api.telegram.org/bot${leasedToken}/getMe`),
      );
    }
    const evidence = await run(
      status === "blocked"
        ? { OPENCLAW_QA_CREDENTIAL_SOURCE: "env", TELEGRAM_BOT_TOKEN: "generic-token" }
        : undefined,
    );
    expect(evidence.entries[0]?.result.status).toBe(status);
    const output = await log();
    expect(output).not.toContain(leasedToken);
    expect(JSON.stringify(evidence)).not.toContain(leasedToken);
    if (status === "blocked") {
      expect(output).toContain("blocked");
      expect(output).not.toContain("generic-token");
      return;
    }
    expect(credential.release).toHaveBeenCalledOnce();
    if (status === "fail") {
      return;
    }
    expect(instance.startGateway).toHaveBeenCalledOnce();
    expect(instance.cleanup).toHaveBeenCalledOnce();
    expect(credential.stop).toHaveBeenCalledOnce();
    const options = createInstance.mock.calls[0]?.[0];
    expect(options).toHaveProperty("config.channels.telegram.defaultAccount", "qa-live");
    expect(options).toHaveProperty(
      "config.channels.telegram.accounts.qa-live.botToken",
      leasedToken,
    );
    expect(options).toHaveProperty("config.plugins", {
      allow: ["telegram"],
      entries: { telegram: { enabled: true } },
    });
    expect(options?.env).toEqual({
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    });
    expect(output).toContain("product startAccount resolved getMe bot identity before polling");
    expect(output).toContain("[REDAC");
  },
);

it("requires product startup to precede polling and bounds the wait", async () => {
  const { instance } = fixture();
  instance.logs = () =>
    "[telegram][diag] polling cycle started\n[qa-live] starting provider (@qa_test_bot)\n";
  await expect(testing.waitForProductStartup(instance, 10)).rejects.toThrow(
    "product startup getMe timed out",
  );
});
