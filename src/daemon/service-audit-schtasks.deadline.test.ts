import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as layout from "./schtasks-layout.js";
import { buildScheduledTaskXml } from "./schtasks-xml.js";
import {
  auditScheduledTaskDefinition,
  readScheduledTaskDefinitionMutationCapability,
} from "./service-audit-schtasks.js";
import type { ServiceDefinitionDrift } from "./service-audit-types.js";
import { fixture, native } from "./service-definition-backup.test-support.js";

afterEach(() => vi.useRealTimers());

async function timedFixture() {
  const f = await fixture("win32");
  f.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "0";
  f.setTask(
    buildScheduledTaskXml({
      taskDescription: "OpenClaw Gateway",
      taskUser: "operator",
      launchPath: f.sourcePath,
    }).replaceAll("<UserId>operator</UserId>", "<UserId>S-1-5-21-1-2-3-1001</UserId>"),
  );
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  native.task.mockClear();
  native.identity.mockClear();
  return {
    ...f,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("shares one allowance across XML, account identity and command inspection", async () => {
  const f = await timedFixture();
  const query = native.task.getMockImplementation()!;
  native.task.mockImplementation(async (args) => {
    f.advance(20);
    return query(args);
  });
  native.identity.mockImplementation(async () => {
    f.advance(30);
    return { code: 0, stdout: "S-1-5-21-1-2-3-1001\n", stderr: "", termination: "exit" };
  });
  const findings: ServiceDefinitionDrift[] = [];
  await auditScheduledTaskDefinition(f.env, findings, 100, f.command);
  expect(findings.filter(({ kind }) => kind === "unknown-edit")).toEqual([]);
  expect(native.task.mock.calls[0]?.[1]).toBe(100);
  expect(native.identity.mock.calls[0]?.[2]?.timeout).toBe(80);
  expect(vi.mocked(layout.readScheduledTaskCommand).mock.calls.at(-1)?.[1]?.deadline).toBe(100);
});

it.each(["xml", "identity", "launcher"] as const)(
  "rejects a late %s observation before admitting later inspection work",
  async (stage) => {
    const f = await timedFixture();
    const query = native.task.getMockImplementation()!;
    native.task.mockImplementation(async (args) => {
      f.advance(stage === "xml" ? 100 : 20);
      return query(args);
    });
    native.identity.mockImplementation(async () => {
      f.advance(stage === "identity" ? 80 : 30);
      return { code: 0, stdout: "S-1-5-21-1-2-3-1001\n", stderr: "", termination: "exit" };
    });
    let commandFinished = false;
    const readCommand = vi.mocked(layout.readScheduledTaskCommand).getMockImplementation()!;
    vi.mocked(layout.readScheduledTaskCommand)
      .mockClear()
      .mockImplementation(async (...args) => {
        const command = await readCommand(...args);
        commandFinished = true;
        return command;
      });
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const content = await read(...args);
      if (stage === "launcher" && commandFinished && args[0] === f.sourcePath) {
        f.advance(50);
      }
      return content;
    });
    await expect(auditScheduledTaskDefinition(f.env, [], 100, f.command)).rejects.toMatchObject({
      reason: "windows-task-inspection-failed",
      timeoutMs: 0,
    });
    if (stage === "xml") {
      expect(native.identity).not.toHaveBeenCalled();
    }
    if (stage !== "launcher") {
      expect(layout.readScheduledTaskCommand).not.toHaveBeenCalled();
    }
  },
);

it.each(["within", "late", "cleanup"] as const)(
  "uses the final XML query's remaining allowance and retains %s result semantics",
  async (outcome) => {
    const f = await timedFixture();
    // The capability's command equality is independent of the separately tested parser.
    vi.mocked(layout.readScheduledTaskCommand).mockImplementation(async () => f.command);
    const query = native.task.getMockImplementation()!;
    const cleanup = new CommandProcessCleanupError();
    const finalStarted = createDeferred();
    const finalResult = createDeferred<{ code: number; stdout: string; stderr: string }>();
    let queries = 0;
    native.task.mockImplementation(async (args) => {
      queries += 1;
      if (queries === 1) {
        f.advance(20);
      } else {
        f.advance(outcome === "within" ? 49 : 50);
        if (outcome === "cleanup") {
          finalStarted.resolve();
          return await finalResult.promise;
        }
      }
      return query(args);
    });
    native.identity.mockImplementation(async () => {
      f.advance(30);
      return { code: 0, stdout: "S-1-5-21-1-2-3-1001\n", stderr: "", termination: "exit" };
    });
    const pending = readScheduledTaskDefinitionMutationCapability(f.env, { timeoutMs: 100 });
    if (outcome === "cleanup") {
      let settled = false;
      const observed = pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await awaitGateBeforeSettlement(
          finalStarted.promise,
          pending,
          "Final query was not reached",
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(false);
      } finally {
        finalResult.reject(cleanup);
        await observed;
      }
      await expect(pending).rejects.toBe(cleanup);
    } else {
      await expect(pending).resolves.toMatchObject({
        kind: outcome === "within" ? "writable" : "unknown",
      });
    }
    expect(native.task.mock.calls.map(([, allowance]) => allowance)).toEqual([100, 50]);
  },
);
