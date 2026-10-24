import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WizardNextResult,
  WizardStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { startWizardGateway } from "./gateway-wizard.test-support.js";
import { resetGatewayTestState } from "./gateway.test-support.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;

describe("gateway wizard e2e", () => {
  beforeEach(resetGatewayTestState);
  afterEach(resetGatewayTestState);

  it(
    "requires boolean consent through wizard.next",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const confirmations: boolean[] = [];
      await using gateway = await startWizardGateway({
        wizardRunner: async (_opts, _runtime, prompter) => {
          confirmations.push(await prompter.confirm({ message: "Continue?", initialValue: false }));
        },
      });
      const client = await gateway.connect();
      for (const { value, expected } of [
        { value: "false", expected: false },
        { value: false, expected: false },
        { value: true, expected: true },
      ]) {
        const start = await client.request<WizardStartResult>("wizard.start", { mode: "local" });
        expect(start.step).toMatchObject({ type: "confirm", initialValue: false });
        const result = await client.request<WizardNextResult>("wizard.next", {
          sessionId: start.sessionId,
          answer: { stepId: start.step?.id, value },
        });
        expect(result).toMatchObject({ done: true, status: "done" });
        expect(confirmations.at(-1)).toBe(expected);
      }
    },
  );

  it("contains hosted wizard exits", { timeout: GATEWAY_E2E_TIMEOUT_MS }, async () => {
    let exitCode = 0;
    const runner = async (_opts: unknown, runtime: RuntimeEnv, prompter: WizardPrompter) => {
      await prompter.outro("wizard complete");
      runtime.exit(exitCode);
    };
    await using gateway = await startWizardGateway({
      wizardRunner: runner,
      channelWizardRunner: runner,
    });
    const client = await gateway.connect();
    // Catch a regressed host exit without terminating the Vitest worker.
    const processExit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Gateway process exit ${code}`);
    });
    try {
      for (const flow of ["setup", "channels"] as const) {
        for (const nextExitCode of [0, 23] as const) {
          exitCode = nextExitCode;
          const status = exitCode === 0 ? "done" : "error";
          const start = await client.request<WizardStartResult>(
            "wizard.start",
            flow === "channels" ? { flow } : { mode: "local" },
          );
          expect(start).toMatchObject({ done: false, status: "running" });
          expect(start.step?.id).toBeTruthy();
          const result = await client.request<WizardNextResult>("wizard.next", {
            sessionId: start.sessionId,
            answer: { stepId: start.step?.id, value: null },
          });
          expect(result).toMatchObject({ done: true, status });
          if (exitCode !== 0) {
            expect(result.error).toContain(String(exitCode));
          }
          expect(processExit).not.toHaveBeenCalled();
          await expect(client.request("health", {})).resolves.toBeDefined();
        }
      }
    } finally {
      processExit.mockRestore();
    }
  });

  it(
    "routes wizard.start flow channels to the channel wizard runner",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const channelRuns: Array<string | undefined> = [];
      await using gateway = await startWizardGateway({
        wizardRunner: async () => {
          throw new Error("setup wizard runner must not run for flow channels");
        },
        channelWizardRunner: async (opts, _runtime, prompter) => {
          channelRuns.push(opts.channel);
          await prompter.intro("Channel setup");
          const choice = await prompter.select({
            message: "channel",
            options: [{ value: opts.channel ?? "none", label: opts.channel ?? "none" }],
          });
          opts.onConfigured?.([{ channel: choice, accountId: "default" }]);
          await prompter.outro(`configured ${choice}`);
        },
      });
      const client = await gateway.connect("vitest-wizard-channels");
      for (const testCase of [
        { label: "omitted", channel: undefined, expected: "none" },
        { label: "canonical", channel: "telegram", expected: "telegram" },
        { label: "alias", channel: "imsg", expected: "imsg" },
      ]) {
        const start = await client.request<WizardStartResult>("wizard.start", {
          flow: "channels",
          ...(testCase.channel === undefined ? {} : { channel: testCase.channel }),
        });
        const sessionId = start.sessionId;
        expect(typeof sessionId, testCase.label).toBe("string");
        let next: WizardStartResult | WizardNextResult = start;
        const seenSteps: string[] = [];
        while (!next.done) {
          const step = next.step;
          if (!step) {
            throw new Error("wizard missing step");
          }
          seenSteps.push(step.type);
          next = await client.request<WizardNextResult>(
            "wizard.next",
            {
              sessionId,
              answer: { stepId: step.id, value: step.type === "select" ? testCase.expected : null },
            },
            { timeoutMs: 60_000 },
          );
        }
        expect(next.status, `${testCase.label}: seenSteps=${seenSteps.join(",")}`).toBe("done");
        expect(seenSteps, testCase.label).toContain("select");
        expect(next.channels, testCase.label).toEqual([testCase.expected]);
        expect(next.accounts, testCase.label).toEqual([
          { channel: testCase.expected, accountId: "default" },
        ]);
      }
      expect(channelRuns).toEqual([undefined, "telegram", "imsg"]);
    },
  );
});
