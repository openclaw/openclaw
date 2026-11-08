// Real CLI, Gateway handlers, and persisted cron edits; only RPC transport is replaced.
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { loadCronStore } from "../../cron/store.js";
import {
  callCron,
  createReadService,
} from "../../gateway/server-methods/cron-read.test-support.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import {
  makeContextParams,
  makeCronState,
} from "../../gateway/server-request-context.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = await vi.hoisted(async () => ({
  runtime: (await import("../test-runtime-mock.js")).createInertRuntime(vi),
  rpc: vi.fn(),
}));
vi.mock("../gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway-rpc.js")>()),
  callGatewayFromCli: mocks.rpc,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
const { registerCronCli } = await import("../cron-cli.js");

it("warns only about dropped command environment keys after a successful edit", async () => {
  await withOpenClawTestState(
    { layout: "home", prefix: "openclaw-command-env-" },
    async (state) => {
      await state.writeConfig({});
      const storePath = state.statePath("cron", "jobs.json");
      const cron = createReadService({
        storePath,
        cronEnabled: false,
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
      });
      const contextParams = makeContextParams();
      contextParams.runtime.runtimeState.cronState = makeCronState({
        cron,
        storePath,
        cronEnabled: false,
      });
      const context = createGatewayRequestContext(contextParams);
      context.getRuntimeConfig = () => ({});
      let rejectUpdate = false;
      mocks.rpc.mockImplementation(async (method: string, _opts: unknown, params = {}) => {
        if (method === "cron.status") {
          return { enabled: true };
        }
        if (method === "cron.update" && rejectUpdate) {
          throw new Error("fixture update rejected");
        }
        // Match the JSON RPC wire, which omits undefined fields in requests and responses.
        // oxlint-disable-next-line unicorn/prefer-structured-clone
        const wireParams = JSON.parse(JSON.stringify(params));
        const response = await callCron(context, method, wireParams);
        const [ok, payload, error] = response.mock.calls.at(-1) ?? [];
        if (!ok) {
          throw new Error(error?.message ?? "missing Gateway response");
        }
        // oxlint-disable-next-line unicorn/prefer-structured-clone
        return JSON.parse(JSON.stringify(payload));
      });
      const edit = async (...args: string[]) => {
        mocks.runtime.error.mockClear();
        const program = new Command().exitOverride();
        registerCronCli(program);
        await program
          .parseAsync(["automations", "edit", job.id, ...args], { from: "user" })
          .catch((error: unknown) => {
            throw new Error(warning(), { cause: error });
          });
      };
      const warning = () => mocks.runtime.error.mock.calls.flat().join("\n");
      const storedEnv = async () => (await loadCronStore(storePath)).jobs[0]?.payload;
      const job = await cron.add({
        name: "command-env-proof",
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "command",
          argv: ["echo", "fixture"],
          env: { KEEP: "old-synthetic-value", DROP: "dropped-synthetic-secret" },
        },
        delivery: { mode: "none" },
      });
      try {
        await edit("--command-input", "");
        expect(warning()).toBe("");
        await edit("--command-env", "KEEP=new-synthetic-value");
        expect(await storedEnv()).toMatchObject({ env: { KEEP: "new-synthetic-value" } });
        expect(await storedEnv()).not.toHaveProperty("env.DROP");
        expect(warning()).toContain("DROP");
        expect(warning()).toContain("--command-env");
        for (const value of [
          "old-synthetic-value",
          "dropped-synthetic-secret",
          "new-synthetic-value",
        ]) {
          expect(warning()).not.toContain(value);
        }
        await edit("--command-env", "KEEP=retained", "--command-env", "NEW=added");
        expect(warning()).toBe("");
        rejectUpdate = true;
        await expect(edit("--command-env", "KEEP=rejected")).rejects.toThrow();
        expect(warning()).not.toContain("removed");
        expect(await storedEnv()).toMatchObject({ env: { KEEP: "retained", NEW: "added" } });
      } finally {
        cron.stop();
        mocks.rpc.mockReset();
      }
    },
  );
});
