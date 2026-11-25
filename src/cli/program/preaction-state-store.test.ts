import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Runtime from "../../runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import type { CliGatewayStateDirOutcome } from "../state-dir-gateway-check.js";
import { registerPreActionHooks } from "./preaction.js";
const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  check: vi.fn<() => Promise<CliGatewayStateDirOutcome>>(async () => ({ kind: "allow" })),
  debug: vi.fn(),
  log: vi.fn(),
  ensureBootstrap: vi.fn(async () => {}),
}));
vi.mock("../state-dir-gateway-check.js", () => ({ checkCliGatewayStateDir: mocks.check }));
vi.mock("../../logger.js", () => ({ logDebug: mocks.debug }));
vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Runtime>();
  return { ...actual, defaultRuntime: { ...actual.defaultRuntime, log: mocks.log } };
});
vi.mock("../command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: mocks.ensureBootstrap,
}));
const program = new Command().name("openclaw");
program.command("configure").action(mocks.action);
registerPreActionHooks(program, "test");
let originalArgv: string[];
beforeEach(() => {
  originalArgv = [...process.argv];
  vi.clearAllMocks();
  process.argv = ["node", "openclaw", "configure"];
});
afterEach(() => {
  process.argv = originalArgv;
});

describe("state-store preAction guard", () => {
  it.each(["refuse", "unavailable", "warn", "abort"] as const)("%s before action", async (kind) => {
    const work = new AsyncWorkScope();
    const message =
      kind === "refuse" ? "state stores differ" : "Service paths could not be verified.";
    mocks.check.mockImplementationOnce(async () => {
      if (kind === "abort") {
        work.beginClose();
      }
      if (kind === "unavailable" || kind === "abort") {
        throw new Error("inspection failed");
      }
      return { kind, message };
    });
    const parsed = work.run(() => program.parseAsync(process.argv));
    if (kind === "refuse" || kind === "abort") {
      await expect(parsed).rejects.toMatchObject(
        kind === "abort"
          ? { name: "AbortError" }
          : { name: "ExpectedCliError", humanOutput: message },
      );
      expect(mocks.ensureBootstrap).not.toHaveBeenCalled();
      expect(mocks.action).not.toHaveBeenCalled();
    } else {
      await expect(parsed).resolves.toBe(program);
      expect(mocks.action).toHaveBeenCalledOnce();
    }
    expect(mocks.debug.mock.calls).toEqual(
      kind === "unavailable" ? [["state-store guard unavailable: inspection failed"]] : [],
    );
    expect(mocks.log.mock.calls).toEqual(kind === "warn" ? [[message]] : []);
  });
});
